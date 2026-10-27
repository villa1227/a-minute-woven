import math
import time

import cv2
import numpy as np


class PupilDetector:
    """Conservative dark-contour candidates, NOT a validated pupillometer."""
    def __init__(self):
        self.face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        self.eye = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml")
        self.cached_rois = {"image_left": None, "image_right": None}
        self.next_detection = 0

    def automatic_rois(self, gray):
        now = time.monotonic()
        if now < self.next_detection:
            return dict(self.cached_rois)
        self.next_detection = now + .5
        small = cv2.resize(gray, None, fx=0.5, fy=0.5)
        faces = self.face.detectMultiScale(small, 1.15, 5, minSize=(60, 60))
        self.cached_rois = {"image_left": None, "image_right": None}
        if len(faces):
            x, y, w, h = [int(v * 2) for v in max(faces, key=lambda f: f[2]*f[3])]
            upper = gray[y:y+int(h*0.6), x:x+w]
            eyes = self.eye.detectMultiScale(upper, 1.1, 5, minSize=(20, 15))
            # Assign by face half, never by detection order. A missing eye stays missing.
            for side, target in (("image_left", 0.3), ("image_right", 0.7)):
                candidates = [e for e in eyes if (e[0]+e[2]/2 < w/2) == (side == "image_left")]
                if candidates:
                    ex, ey, ew, eh = min(candidates, key=lambda e: ((e[0]+e[2]/2)/w-target)**2 + ((e[1]+e[3]/2)/h-0.28)**2)
                    self.cached_rois[side] = (x+int(ex), y+int(ey), int(ew), int(eh))
        return dict(self.cached_rois)

    def automatic_roi(self, gray):
        return self.automatic_rois(gray)["image_left"]

    def measure_pair(self, frame, manual_rois=None):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        manual_rois = manual_rois or {}
        automatic = (self.automatic_rois(gray) if any(manual_rois.get(side) is None
                     for side in ('image_left', 'image_right')) else {})
        eyes = {}
        for side in ("image_left", "image_right"):
            manual = manual_rois.get(side)
            roi = manual if manual is not None else automatic[side]
            eyes[side] = self._measure_roi(gray, roi, "manual" if manual is not None else "automatic")
        result = {"eyes": eyes, "eye_coordinate_system": "unmirrored_image_left_right",
                  "algorithm": "dark-contour-binocular-v2"}
        # Stable separate CSV columns; nested JSONL retains every per-eye field.
        for side, eye in eyes.items():
            for field in ("roi", "roi_mode", "quality", "candidate_diameter_px", "candidate_center_px", "sharpness"):
                result[side + "_" + field] = eye[field]
        return result

    def measure(self, frame, manual_roi=None):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        roi = manual_roi if manual_roi is not None else self.automatic_roi(gray)
        return self._measure_roi(gray, roi, "manual" if manual_roi is not None else "automatic")

    def _measure_roi(self, gray, roi, mode):
        result = {"roi": None, "roi_mode": mode,
                  "mean_gray": float(gray.mean()), "roi_gray": None, "sharpness": None,
                  "quality": "no_eye_roi", "candidate_diameter_px": None,
                  "candidate_center_px": None, "candidate_ellipse_px": None,
                  "circularity": None, "contrast_gray": None,
                  "algorithm": "dark-contour-v1"}
        if roi is None:
            return result
        x, y, w, h = map(int, roi)
        x, y = max(0, x), max(0, y)
        w, h = min(w, gray.shape[1]-x), min(h, gray.shape[0]-y)
        result["roi"] = [x, y, w, h]
        if min(w, h) < 20:
            result["quality"] = "roi_too_small"
            return result
        crop = gray[y:y+h, x:x+w]
        result["roi_gray"] = float(crop.mean())
        result["sharpness"] = float(cv2.Laplacian(crop, cv2.CV_64F).var())
        if result["sharpness"] < 12:
            result["quality"] = "blurred"
            return result
        smooth = cv2.GaussianBlur(crop, (5, 5), 0)
        candidates = []
        otsu, _ = cv2.threshold(smooth, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        thresholds = [float(otsu)] + [float(np.percentile(smooth, q)) for q in (10, 18, 26)]
        for threshold in thresholds:
            mask = (smooth <= threshold).astype(np.uint8) * 255
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                area = cv2.contourArea(contour)
                perimeter = cv2.arcLength(contour, True)
                bx, by, bw, bh = cv2.boundingRect(contour)
                if len(contour) < 5 or not 0.003*w*h < area < 0.22*w*h:
                    continue
                if bx < 2 or by < 2 or bx+bw >= w-2 or by+bh >= h-2 or perimeter <= 0:
                    continue
                circularity = 4*math.pi*area/(perimeter*perimeter)
                (cx, cy), (a, b), angle = cv2.fitEllipse(contour)
                if min(a, b) < 4 or min(a, b)/max(a, b) < 0.45 or circularity < 0.48:
                    continue
                inside = np.zeros(crop.shape, np.uint8)
                cv2.drawContours(inside, [contour], -1, 255, -1)
                ring = cv2.dilate(inside, np.ones((9, 9), np.uint8)) - inside
                if not np.any(ring):
                    continue
                contrast = float(crop[ring > 0].mean() - crop[inside > 0].mean())
                if contrast < 8:
                    continue
                center_penalty = math.hypot((cx-w/2)/w, (cy-h/2)/h)
                score = circularity + min(contrast, 80)/80 - center_penalty
                candidates.append((score, cx, cy, a, b, angle, area, circularity, contrast))
        if not candidates:
            result["quality"] = "no_candidate"
            return result
        _, cx, cy, a, b, angle, area, circularity, contrast = max(candidates)
        result.update(quality="candidate_unvalidated", candidate_diameter_px=2*math.sqrt(area/math.pi),
                      candidate_center_px=[float(x+cx), float(y+cy)],
                      candidate_ellipse_px=[float(a), float(b), float(angle)],
                      circularity=float(circularity), contrast_gray=contrast)
        return result
