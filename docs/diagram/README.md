# Mermaid 다이어그램

이 디렉터리의 `.mmd` 파일이 다이어그램의 정본입니다. 전역 `mmdc` 설치 없이 다음 명령으로 모든 SVG와 PNG를 재생성합니다.

```bash
bun run diagram:render
```

`diagram:render`는 `bunx --package @mermaid-js/mermaid-cli mmdc`를 사용합니다. 각 SVG는 흰색 배경으로, PNG는 흰색 배경의 2x scale로 렌더링합니다. 정확한 입력·출력 파일과 옵션은 `package.json`의 script를 기준으로 합니다.
