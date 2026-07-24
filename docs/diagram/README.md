# Mermaid 다이어그램

이 디렉터리의 `.mmd` 파일이 다이어그램의 정본입니다. 전역 `mmdc` 설치 없이 다음 명령으로 SVG와 PNG를 재생성합니다.

```bash
bunx --package @mermaid-js/mermaid-cli mmdc -i docs/diagram/architecture.mmd -o docs/diagram/architecture.svg -b white
bunx --package @mermaid-js/mermaid-cli mmdc -i docs/diagram/architecture.mmd -o docs/diagram/architecture.png -b white -s 2
bunx --package @mermaid-js/mermaid-cli mmdc -i docs/diagram/event-flow.mmd -o docs/diagram/event-flow.svg -b white
bunx --package @mermaid-js/mermaid-cli mmdc -i docs/diagram/event-flow.mmd -o docs/diagram/event-flow.png -b white -s 2
```
