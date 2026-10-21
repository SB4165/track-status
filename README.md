# 트랙 업무 진행현황

배치도 기반 트랙 프로젝트 공정 진행현황 보드 (GitHub Pages + Google Apps Script + Google Sheets)

## 구성
| 파일 | 역할 |
|---|---|
| index.html, style.css, app.js | 화면 (PC/모바일 반응형) |
| config.js | Apps Script 웹앱 URL 설정 (비워두면 데모 모드) |
| Code.gs | 백엔드 API (Apps Script에 붙여넣기) |

## 데이터 (DB 스프레드시트: "트랙 업무 진행현황 DB", setup() 실행 시 자동 생성)
- Layout: 칸 번호 / 행 / 열 / 행병합 / 열병합 / 사용여부 → **사옥 이전 시 이 시트만 수정**
- Projects: 칸에 등록된 프로젝트 (state: active / shipped / removed)
- Steps: 프로젝트별 14개 공정 기록
- History: 변경 이력

프로젝트명은 참조 시트(공정별 부적합 관리대장, gid=664632288)의 **M열에 TRACK이 포함된 행의 L열** 값을 사용합니다 (10분 캐시, 등록 화면의 "목록 새로고침"으로 즉시 갱신).

## 배치 변경 (사옥 이전)
Layout 시트에서 칸별 row, col을 바꾸면 화면이 그대로 다시 그려집니다. 열 개수는 가장 큰 col 값으로 자동 결정됩니다. 칸 추가는 행 추가, 칸 제외는 active를 FALSE로 바꾸면 됩니다.
프로젝트 기록은 칸이 아니라 프로젝트 ID에 저장되므로 배치가 바뀌어도 유지됩니다.

## 입력 권한 키 (선택)
Apps Script > 프로젝트 설정 > 스크립트 속성에 WRITE_KEY를 추가하면 저장할 때 키를 요구합니다.

## 추후 자동화
4)~10), 12), 13) 공정의 NAS 파일 업로드 확인은 Steps.fileCount, Steps.fileCheckedAt 열에 사내 PC 스크립트가 결과를 기록하는 방식으로 연동 예정입니다.
