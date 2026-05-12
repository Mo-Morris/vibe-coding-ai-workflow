name: pet-url-label-workflow
label: URL 猫狗标注演示
description: 上游写入含 url 的列表，在标注节点中选小猫或小狗，输出 labeled_items.json。
mode: manual-confirm
nodes:
  - id: urls
    node: url-items-source
    depends_on: []
  - id: pets
    node: url-pet-labeler
    depends_on: [urls]
