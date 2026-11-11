# chromebook-tablog (수업 탭 기록)

학교 관리 크롬북에 관리 콘솔로 강제 설치하는 크롬 확장 프로그램입니다(Manifest V3).
수업 시간에 학생이 보고 있는 활성 탭의 **사이트 이름**을 기록합니다. **유튜브**처럼 허용한 사이트는 **탭 제목**도 기록합니다. 모은 기록은 담임교사의 구글 시트(Apps Script 웹 앱)로 보냅니다.

- 화면, 입력 내용, 전체 URL은 수집하지 않습니다.
- 기록은 교사 계정의 시트에만 저장되고 14일 후 자동으로 지워집니다.
- 웹 앱 주소, 토큰, 수업 시간 같은 설정은 관리 콘솔의 확장 프로그램 정책(`chrome.storage.managed`)으로 넣습니다. 저장소에는 비밀 값이 없습니다.

## 구성
| 경로 | 내용 |
|---|---|
| `extension/` | 확장 프로그램 소스 |
| `apps-script/Code.gs` | 구글 시트에 붙여 넣는 수신 스크립트 |
| `docs/` | GitHub Pages로 배포하는 `tablog.crx`, `update.xml` |
| `build.mjs` | 아이콘 생성, 서명, `docs/` 출력 |
| `test/` | 모의 객체 테스트 (`npm test`) |

## 설치
- 확장 프로그램 ID: `fjeaigjggicdfincocceobnoiccjecib`
- 업데이트 URL: `https://nyjb.github.io/chromebook-tablog/update.xml`

관리 콘솔 → 기기 → Chrome → 앱 및 확장 프로그램 → 사용자 및 브라우저 → 조직 단위 선택 → **ID로 추가 → 맞춤 URL**에 위 ID와 URL을 넣고, 설치 정책을 **강제 설치**로 정합니다. 확장 프로그램 정책 예:

```json
{
  "endpoint": { "Value": "https://script.google.com/macros/s/…/exec" },
  "token": { "Value": "…" },
  "titleDomains": { "Value": ["youtube.com"] },
  "days": { "Value": [1, 2, 3, 4, 5] },
  "start": { "Value": "08:30" },
  "end": { "Value": "15:00" },
  "intervalMinutes": { "Value": 10 }
}
```

학생과 보호자에게 미리 알리고, 학교 개인정보 절차에 따라 사용하세요.
