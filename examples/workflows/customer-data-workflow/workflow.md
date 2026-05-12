name: customer-data-workflow
label: 客户数据处理流程
description: 清洗客户数据，人工确认后生成报告。
mode: manual-confirm
nodes:
  - id: clean
    node: data-cleaning
    depends_on: []
  - id: report
    node: report-generator
    depends_on: [clean]
