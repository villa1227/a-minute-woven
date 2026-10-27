// UNO / Grove GSR on A0. Protocol: GSR,version,sequence,millis,adc.
#include <Arduino.h>
const uint32_t PERIOD_MS = 50;
uint32_t nextSample;
uint32_t sequence = 0;
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println(F("#GSR,1,UNO,A0,10,20"));
  nextSample = millis();
}
void loop() {
  const uint32_t now = millis();
  if ((int32_t)(now - nextSample) < 0) return;
  nextSample += PERIOD_MS;
  // Skip missed deadlines without fabricating catch-up samples.
  if ((int32_t)(now - nextSample) >= 0) nextSample = now + PERIOD_MS;
  const int adc = analogRead(A0);
  Serial.print(F("GSR,1,"));
  Serial.print(sequence++);
  Serial.print(',');
  Serial.print(now);
  Serial.print(',');
  Serial.println(adc);
}
