# 로컬 Claude 핸드오프 프롬프트 (Windows PC에서 실행)

> Hermes가 설치된 Windows PC의 Claude(데스크톱 앱 Code 탭 또는 Claude Code CLI)에 아래 블록을 그대로 붙여넣음.

```text
[핸드오프] 이 PC에서 돌고 있는 Hermes Agent(Nous Research)를 세컨드브레인(Obsidian 볼트)과 연결하는 작업을 이어받아줘. 설계 문서는 GitHub 저장소 denvern75-droid/- 의 claude/keen-wright-rhbdrr 브랜치에 있음(README.md, hermes/standing-instructions.md, hermes/cron-prompts.md, hermes/config.example.yaml, vault-skeleton/, docs/운영가이드.md). 사용자는 비개발자이므로 명령어 대신 결과와 다음 할 일만 한국어 개조식으로 보고해줘.

1단계 점검(읽기 전용, 아무것도 바꾸지 말 것): hermes 실행 파일 위치와 버전(hermes --help, hermes version 등으로 확인), Hermes 설정 폴더와 config.yaml 위치, 연결된 MCP 서버, 메모리·상시 지침 저장 위치, 텔레그램 게이트웨이 구동 여부, 예약 작업 목록(hermes cron list), obsidian 스킬이 볼트 경로를 어디서 읽는지, 구글드라이브 데스크톱 동기화 경로, 기존 Obsidian 볼트 유무, git 설치 여부. 결과를 표로 보고하고 여기서 멈춰서 내 승인을 받아줘.

2단계 볼트 연결(승인 후): 저장소를 %USERPROFILE%\hermes-kit 에 내려받고, vault-skeleton 내용을 볼트 경로(기존 볼트 > 구글드라이브\SecondBrain > %USERPROFILE%\Documents\SecondBrain 순으로 결정)에 복사함. 기존 파일은 덮어쓰지 않음. Hermes의 obsidian 스킬과 파일 작업이 이 볼트를 기본으로 쓰도록 설정함. config.yaml·환경변수 변경은 변경 전후 비교를 보여주고 승인받은 뒤 적용하고, 원본은 백업해둠.

3단계 지침·예약 작업(승인 후): hermes/standing-instructions.md 코드블록의 규칙을 <볼트>를 실제 경로로 바꿔 Hermes 상시 지침(메모리 또는 컨텍스트 파일)에 등록함. hermes/cron-prompts.md 의 ①아침 브리핑, ②긴급 알림, ⑥섭외 후속 3개만 예약 작업으로 등록하고 결과는 텔레그램으로 보내게 함. 카카오 발송 도구가 없으면 텔레그램 대체 발송으로 등록하고 그 사실을 보고함.

4단계 검증: Hermes에게 비대화형으로 질의해(hermes --help에서 단발 질의 옵션 확인) 볼트의 90_Daily에 오늘 날짜 파일을 만들고 다시 읽게 해서 연결을 확인함. hermes cron list 결과와 게이트웨이 상태를 최종 보고함.

금지사항: _private 폴더 읽기·쓰기 금지, 개인정보를 메신저로 보내지 않음, 승인 없이 설정 변경·파일 삭제 금지, C:\WINDOWS\system32 에 파일 생성 금지.
```
