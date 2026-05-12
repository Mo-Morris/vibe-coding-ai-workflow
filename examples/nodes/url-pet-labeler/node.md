name: url-pet-labeler
label: URL 猫狗标注
description: 读取上游 items.json（每项含 url），在 UI 中标注为小猫或小狗，并输出 labeled_items.json。
command: python3 main.py
ui:
  entry: ui/index.html
capabilities:
  query: true
  search: true
  get: true
  update: true
