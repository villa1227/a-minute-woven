# OpenCV Zoo attribution

Pinned upstream revision: 48b10fa505aeb51fbd127fc60a5c660040e823b7
https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7

Progressive Teacher / MobileFaceNet expression inference and alignment conventions:
Copyright (C) 2022, Shenzhen Institute of Artificial Intelligence and Robotics for Society, all rights reserved.
Third party copyrights are property of their respective owners.
Upstream facial_fer_model.py and expression model are distributed under Apache-2.0;
see Apache-2.0.txt and the upstream expression README.

YuNet face detector:
Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>
MIT; see YuNet-MIT.txt.

This project's adaptation implements the documented preprocessing with NumPy and
OpenCV, exposes all seven scores, adds Windows Unicode-safe buffer loading,
and integrates independent latest-frame inference and timestamped recording.
Model binaries are installed separately using a pinned, hash-checked manifest.
