# 텍스트 액션 (Windows · Claude 연계)

맥 PopClip 방식의 윈도우용 업무 보조 도구임. 아무 프로그램에서 글을 선택하고 `Ctrl+Alt+Space`를 누르면 아래 변환을 바로 적용함.

| 키 | 액션 |
|---|---|
| 1 | 개조식 변환 (~함/~임/~됨) |
| 2 | 공문 윤문 |
| 3 | 3줄 요약 |
| 4 | 쉬운 말(이지리드) |
| 5 | 법령 근거 점검 |
| 6 | 대체텍스트 작성 |

## 설치·실행

```bat
pip install -r requirements.txt
setx ANTHROPIC_API_KEY "발급받은키"
python -m textaction
```

- 명령줄 점검: `python -m textaction --action gaejosik --text "검토 결과 문제가 없습니다."`
- 모델 변경: `setx TEXTACTION_MODEL "claude-haiku-5-5"` (비용 절감용)
- exe 빌드: `build_windows.bat` 실행 → `dist\TextAction.exe`

기획·비용·리스크는 [docs/01_기획서_윈도우용_Claude_업무도구.md](docs/01_기획서_윈도우용_Claude_업무도구.md) 참조함.
