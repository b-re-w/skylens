<div align="center">

# 🛸 SkyLens

**멀티드론 영상을 실시간 3D로 복원하고, 그 위에 AI가 위험구역·사람을 표시하는 재난 인텔리전스 플랫폼**

*NET 챌린지 캠프 시즌13 — 중간평가 프로토타입*

<br/>

![status](https://img.shields.io/badge/status-prototype-9fe8ff)
![stack](https://img.shields.io/badge/Three.js-r0.185-c8c2b8)
![lang](https://img.shields.io/badge/TypeScript-6.0-3178c6)
![build](https://img.shields.io/badge/Vite-8-646cff)
![sync](https://img.shields.io/badge/WebRTC-PeerJS%20%2B%20STUN-ff9a4d)
![splat](https://img.shields.io/badge/Gaussian%20Splatting-real-c084fc)
![tests](https://img.shields.io/badge/e2e-Playwright%206%2F6-39d98a)

</div>

---

## 개요

SkyLens는 여러 대의 드론이 재난 현장을 분할 탐색하며 보낸 영상을 고속망으로 모아 **현장을 실시간 3D(Gaussian Splatting)로 복원**하고, 같은 영상에 **AI를 돌려 위험구역·사람을 감지**해 3D 현장 위에 마커로 얹는 재난 대응 시스템입니다.

이 저장소는 그중 **중간평가용 프로토타입**입니다 — 하드웨어·인프라 없이도 *"드론이 날아가며 탐색 → 그 자리에 3D 공간이 피어남 → AI가 위험/사람을 찾아냄"* 이라는 핵심 서사가 **실제로 작동함**을 보여주는 것이 목표입니다.

> 📄 기획·설계 문서: [IDEA.md](IDEA.md) (기획서) · [ARCHITECTURE.md](ARCHITECTURE.md) (통합 아키텍처) · [PROJECT.md](PROJECT.md) (프로토타입 구현 계획)

---

## 데모 구성 — 두 컴퓨터, 두 화면

데모는 **물리적으로 분리된 두 컴퓨터**에서 각각 한 화면씩 띄우고, **WebRTC(P2P)** 로 상태를 주고받습니다.

| | **SIM** (컴퓨터 A) | **RECON** (컴퓨터 B) |
|---|---|---|
| URL | `/sim.html` | `/recon.html` |
| 성격 | 로우파이 · 남색 · 스캐닝 도트 | 실사 지향 3D 복원 (placeholder) |
| 내용 | 드론 3대가 경로 따라 분할 탐색, 3인칭 추적 카메라 | 드론이 지나간 자리가 시간차를 두고 점점 복원(reveal) |
| 역할 | 시뮬레이션을 **소유**하고 상태를 스트리밍 | 받은 상태로 복원·AI 탐지·카메라를 **로컬 계산** |

SIM에서 드론이 훑고 지나가면 몇 초 뒤 RECON에서 3D가 피어나고, **사람/위험이 감지되면 카메라가 자동으로 줌인 → 탐지 카드 표시 → `탐지 확인` → 원위치 복귀**의 사이클이 돕니다.

> **핵심 트릭 (PROJECT.md §1)**: 두 뷰어는 **같은 하나의 소스**를 씁니다. **Gaussian 스플랫이 유일한 소스**이고, SIM은 그 스플랫의 점들을 뽑아 **로우파이 포인트클라우드**로, RECON은 **풀 스플랫**으로 렌더합니다. 두 컴퓨터가 같은 URL을 받아 동일한 결정적 파이프라인(추출→auto-fit→다운샘플)을 돌리므로 포인트클라우드가 서로 **완전히 동일**합니다. (스플랫이 없거나 로드 실패 시 양쪽 모두 동일한 절차적 폴백 클라우드로 degrade.)

---

## 빠른 시작

> **요구 사항**: Node.js 18+ 와 npm · 두 컴퓨터가 **인터넷**(PeerJS 브로커·STUN)에 접속 가능해야 함

```bash
# 1. 의존성 설치
npm install

# 2. 개발 서버 실행 (LAN에 노출됨 → 다른 컴퓨터에서도 접속 가능)
npm run dev
```

개발 서버가 뜨면 두 개의 주소가 출력됩니다:

```
➜  Local:   http://localhost:5173/
➜  Network: http://192.168.x.x:5173/     ← 다른 컴퓨터는 이 주소 사용
```

이제 **두 컴퓨터에서 같은 방(room)으로** 각자의 화면을 엽니다:

| 컴퓨터 | 접속 주소 |
|---|---|
| A (SIM) | `http://<서버IP>:5173/sim.html?room=demo` |
| B (RECON) | `http://<서버IP>:5173/recon.html?room=demo` |

같은 `?room=` 값이면 자동으로 P2P 연결됩니다. 우측 상단 배지가 **`연결됨`(초록)** 이 되면 성공. (랜딩 페이지 `/` 에서 두 화면 링크와 room 안내를 볼 수 있습니다.)

| 명령어 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (HMR, LAN 노출) |
| `npm run build` | 타입체크(`tsc`) + 멀티페이지 프로덕션 빌드 → `dist/` |
| `npm run preview` | 빌드 결과물 로컬 서빙 |
| `npm test` | Playwright E2E (페이지별 부팅 + 실제 WebRTC 연결/스트리밍) |
| `npm run test:headed` | 브라우저를 띄워서 테스트 실행 |

---

## 연결 방식 (WebRTC)

- **시그널링**: PeerJS 공개 브로커(0.peerjs.com)를 사용합니다. 자체 시그널링 서버를 띄우지 않습니다. `room` 토큰으로 두 피어가 결정적 ID(`skylens-<room>-sim` / `-recon`)로 서로를 찾습니다.
- **NAT 통과**: 구글 공개 STUN 서버(`stun.l.google.com:19302`).
- **데이터**: 연결 수립 후에는 상태(드론 포즈·visited·시각)가 **P2P DataChannel로 직접** 흐릅니다. 브로커는 최초 핸드셰이크만 중계합니다.
- **데이터 흐름**: 단방향 SIM → RECON. `탐지 확인`은 RECON에서 로컬 처리됩니다.

> 방을 나누려면 두 URL의 `?room=` 값을 똑같이 바꾸면 됩니다. 공개 브로커를 공유하므로 데모마다 고유한 room 이름을 권장합니다.

### RECON 스플랫 옵션 (`?splat=`)

RECON 페이지는 실사 Gaussian Splatting을 렌더합니다. 에셋은 공개 CDN에서 런타임 로드되며 저장소에 커밋되지 않습니다.

| 쿼리 | 동작 |
|---|---|
| (없음) | 기본 건물 샘플(room, 36 MB) 로드 |
| `?splat=light` | 가벼운 건물 샘플(counter, 33 MB) — e2e/빠른 확인용 |
| `?splat=off` | 스플랫 끄고 포인트클라우드만 (가장 가벼움) |
| `?splat=https://…` | 임의의 `.splat`/`.ply` URL 로드 |

> 스플랫의 위치·회전·스케일은 [src/core/config.ts](src/core/config.ts)의 `splat`에서 조정합니다(첫 실제 렌더에서 씬에 맞게 튜닝).

---

## 조작법 (SIM 화면)

| 입력 | 동작 |
|---|---|
| **방향키 ↑ ↓ ← →** | 활성 드론 수동 비행 (전/후진 · 좌우 이동) |
| **Q / E** | 활성 드론 고도 하강 / 상승 |
| **1 / 2 / 3** | 조작할 드론 선택 |
| **Tab** | 다음 드론으로 전환 |
| **Space** | 시뮬레이션 일시정지 / 재개 |

> 수동 조작 중 일정 시간(1.5초) 입력이 없으면 드론이 프리셋 경로로 부드럽게 복귀합니다.

---

## 프로젝트 구조

```
├─ index.html            랜딩 (두 화면 링크 + room 안내)
├─ sim.html              SIM 페이지 (컴퓨터 A)
├─ recon.html            RECON 페이지 (컴퓨터 B)
├─ vite.config.ts        멀티페이지 + LAN 노출 설정
└─ src/
   ├─ sim.ts             SIM 부트스트랩: 시뮬 소유 + 상태 송신
   ├─ recon.ts           RECON 부트스트랩: 상태 수신 + 복원/AI 계산
   ├─ core/
   │  ├─ config.ts       룩·타이밍·색상 등 튜닝 상수
   │  ├─ types.ts        공통 타입 (모든 모듈의 계약)
   │  ├─ store.ts        공유 상태 + pub/sub
   │  └─ math.ts         Catmull-Rom 보간, 이징, 댐핑
   ├─ net/
   │  ├─ peer.ts         PeerJS(WebRTC) 트랜스포트 + 구글 STUN
   │  ├─ protocol.ts     SIM→RECON 상태 스냅샷 직렬화
   │  └─ statusUi.ts     room 파싱 + 연결 상태 배지
   ├─ data/
   │  ├─ sceneSource.ts  ★유일 소스: 스플랫 로드→점 추출→auto-fit→다운샘플
   │  ├─ sceneData.ts    절차적 폴백 클라우드 (스플랫 off/실패 시)
   │  ├─ paths.ts        드론 경로 (씬 bounds에서 파생)
   │  └─ detections.ts   탐지 마커 (씬 클라우드에서 파생)
   ├─ drones/
   │  ├─ pathFollower.ts AUTO → MANUAL → RETURNING 상태머신
   │  └─ manualControl.ts 키보드 입력
   ├─ viewer1/
   │  └─ lowfiViewer.ts  SIM: 로우파이 시뮬 + 추적 카메라
   ├─ viewer2/
   │  ├─ reconViewer.ts  RECON: 3D 복원 상황판
   │  ├─ reveal.ts       (폴백) 포인트클라우드 XZ-컬럼 reveal
   │  ├─ splatScene.ts   실사 Gaussian Splatting 레이어 (DropInViewer)
   │  ├─ splatReveal.ts  스플랫 자체 reveal (커버리지 텍스처 + 셰이더 패치)
   │  └─ cameraSync.ts   SYNCED → FOCUSING → LOCKED → RETURNING
   └─ ui/
      ├─ overlay.ts       HUD · 탐지 카드 · 확인 버튼
      ├─ loadingScreen.ts 장면 로딩 오버레이
      └─ toast.ts         알림 토스트

tests/
└─ smoke.spec.ts         Playwright E2E (페이지별 부팅 + 실제 WebRTC 통합)
```

---

## 현재 상태 & 로드맵

**구현됨**
- ✅ 두 컴퓨터 분리 구성 (`/sim.html` · `/recon.html`)
- ✅ WebRTC P2P 동기화 (PeerJS 공개 브로커 + 구글 STUN), 연결 상태 배지
- ✅ 드론 3대 커버리지 스윕(lawnmower) 경로 — 씬 전체를 훑어 건물 전체가 빠짐없이 복원됨 (+ 수동 조작/자동 복귀)
- ✅ 시간차 progressive reveal (드론이 지나간 자리를 지연 복원)
- ✅ 탐지 → 자동 포커스 → 확인 → 복귀 카메라 상태머신
- ✅ **실사 Gaussian Splatting 렌더링** — `@mkkellogg/gaussian-splats-3d`로 RECON에 실제 스플랫을 얹음 (현재는 **공개 샘플**을 런타임 로드하는 테스트 에셋)
- ✅ **단일 소스 일관성** — SIM(로우파이 점)과 RECON(풀 스플랫)이 같은 스플랫에서 파생된 **동일 포인트클라우드**를 사용 (E2E로 검증)
- ✅ **스플랫 자체 progressive reveal** — RECON은 점 오버레이 없이 **실사 스플랫**만 표시하고, 드론 스캔에 따라 스플랫 자체가 드러남 (커버리지 텍스처 + 스플랫 셰이더 패치)
- ✅ E2E 6종 (페이지별 런타임 + WebRTC 연결·스트리밍·탐지 사이클 + 실사 스플랫 로드/셰이더 컴파일 + 양쪽 클라우드 동일성 + 스플랫 reveal)

**후순위 / 다음 단계**
- ⏳ **자체 촬영 스플랫으로 교체** — 지금 스플랫은 공개 샘플(테스트용)입니다. [PROJECT.md §2](PROJECT.md)대로 현장 촬영→GLOMAP/gsplat으로 만든 `.ply`/`.splat`으로 교체 + 씬 정합(transform) 튜닝
- ⏳ 최종 평가: 실제 드론 텔레메트리 · KOREN · Core HPC 파이프라인 연동

---

## 기술 스택

**Three.js** (3D 렌더링) · **@mkkellogg/gaussian-splats-3d** (실사 스플랫) · **TypeScript** · **Vite** (멀티페이지 번들·개발 서버) · **PeerJS / WebRTC** (P2P 동기화) · **Playwright** (E2E 테스트)

<div align="center">
<sub>SkyLens — 재난 현장을 실시간 3D로, 그 위에 AI를 얹다.</sub>
</div>
