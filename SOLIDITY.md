# ANGT — Solidity Logic

Документ описывает все смарт-контракты из репо, формат данных между фронтом / скриптами / контрактами и порядок деплоя.

---

## STATUS — что готово для запуска токена

**Дата заморозки snapshot**: `2026-05-06T07:50:00Z` (`AIRDROP_FROZEN_AT`)

### ✅ Готово

| Блок | Состояние |
|---|---|
| **Контракт FlyANGT** | Готов, supply 500 000 000, owner = treasury (Safe), все 500M минтятся на Safe в конструкторе |
| **Контракт MerkleAirdrop** | Готов, без изменений |
| **Контракт PresaleVestingMerkle** | Готов, **per-user clock**, 36 мес линейно, есть `addInvestor*` для OTC, `activateMerkle` принимает wei |
| **Контракт AllocationRegistry** | Готов, immutable on-chain доказательство TGE-распределения (label/recipient/amount/vested/note) |
| **Ignition модули** | 5 шт. (FlyANGT, MerkleAirdrop, PresaleModule, PresaleVesting, AllocationRegistry) |
| **Параметры Polygon** | treasury/owner = `0xBBC7Ee…490A`, merkle roots проставлены реальными значениями (см. ниже) |
| **Скрипты сбора claims** | `generateAirdropClaims.ts` (off-chain DB), `generatePresaleClaims.ts` (off+on-chain merge), `buildMerkle.ts`, `buildMerkleVesting.ts` |
| **Эндпоинты flyangt** | Заморожены через `AIRDROP_FROZEN=true` в `src/lib/airdrop/frozen.ts`. Claim-эндпоинты отдают 403, в `wallet/verify`/`user/settings`/`stripe/webhook` пропускается reward-блок (но основная логика работает) |
| **Snapshot airdrop** | `airdrop/claims.json`: **18 кошельков, 4 400 ANGT total** |
| **Merkle airdrop** | `airdrop/merkle.json`, root = `0x4020c2a512d07e5f3f21b08390c54d5bcdd41e586d5c75a30aa9a10f5ce42ad3` |
| **Snapshot пресейла** | `airdrop/claimsVesting.json`: **12 кошельков, 162 460.7324085779 ANGT total** (4 off-chain + 10 on-chain → 12 уникальных). Суммы дробные — vesting-контракт это поддерживает (принимает wei) |
| **Merkle пресейл** | `airdrop/merkleVesting.json`, root = `0x22e849df8e7fc8773e9eb3981198d6983a11786455edc788ee63be74f0e23e54` |

### Распределение supply (500 000 000 ANGT)

| Bucket | % | ANGT | Куда |
|---|---|---|---|
| Owner (founder) | 35% | 175 000 000 | один кошелёк, **сразу без vesting** |
| Devs | 5% | 25 000 000 | один кошелёк, **сразу без vesting** |
| Market makers | 2.5% | 12 500 000 | один кошелёк, **сразу без vesting** |
| Airdrop | по snapshot | **4 400** | `MerkleAirdrop` контракт |
| Presale Vesting | по snapshot | **162 460.7324085779** | `PresaleVestingMerkle` контракт |
| Treasury / резерв | остаток | ≈ 287 333 138.27 | остаётся на Safe — DEX-листинг, маркетинг, **OTC-резерв** (фондирование `PresaleVestingMerkle` по требованию при `addInvestor*`) |

GP-кошельки (35 / 5 / 2.5) идут **обычным `transfer` с Safe** без блокировки. Для **прозрачности** TGE-распределение записывается в отдельный read-only `AllocationRegistry` контракт (immutable список `{label, recipient, amountWei, vested, note}`) — любой через Polygonscan видит "Owner — 175M, Devs — 25M, MM — 12.5M, Airdrop — 4 400, Vesting — 162 460.73, Treasury — остаток".

### ⬜ Не готово / нужно сделать

- [ ] **Конкретные адреса** owner / devs / mm для GP-распределения (нужны от пользователя)
- [ ] **`AllocationRegistry` parameters** — заполнить `parameters.polygon.json` массивом `entries` (после получения адресов GP)
- [ ] **Тесты** на `MerkleAirdrop`, `PresaleVestingMerkle`, `AllocationRegistry`
- [ ] **Node 22+** на машине, где будет hardhat compile/test/deploy
- [ ] **Деплой на Amoy** для end-to-end проверки
- [ ] **Деплой на Polygon mainnet**
- [ ] **Verification** на Polygonscan
- [ ] **Прописать `ANGT_ADDRESS`** в `.env` flyangt + адреса airdrop/vesting контрактов в `lib/web3/addresses.ts`
- [ ] **Скрипт `buildSafeBatch.ts`** — собирает JSON для Safe Transaction Builder с 6 операциями (setRoot×2 + transfer×2 + start×2)
- [ ] **Фронт-страницы клейма** (`/app/claim` для airdrop, `/app/vesting` для пресейла)
- [ ] **API эндпоинты** `/api/v1/claim/airdrop/proof/[address]` и `/api/v1/claim/vesting/proof/[address]` — отдают proof из `merkle.json` / `merkleVesting.json`

---

## 0. Карта контрактов

| Контракт | Файл | Назначение |
|---|---|---|
| **FlyANGT** | [contracts/FlyANGT.sol](contracts/FlyANGT.sol) | ERC20-токен, fixed supply 500 000 000 ANGT, минт на treasury (Safe) |
| **MerkleAirdrop** | [contracts/MerkleAirdrop.sol](contracts/MerkleAirdrop.sol) | Раздача airdrop по Merkle-листу. Один клейм на адрес |
| **PresaleVestingMerkle** | [contracts/PresaleVesting.sol](contracts/PresaleVesting.sol) | Vesting для покупателей пресейла + ручное добавление OTC-инвесторов. Per-user clock, 36 мес линейно |
| **AllocationRegistry** | [contracts/AllocationRegistry.sol](contracts/AllocationRegistry.sol) | Immutable on-chain запись TGE-распределения (read-only) |
| **PresaleTimeWeeks** | [contracts/Presale.sol](contracts/Presale.sol) | **Старый** пресейл-контракт. Уже задеплоен на Polygon (`0xdd03…Bed0`), новый деплой не нужен |

Все трое (`FlyANGT`, `MerkleAirdrop`, `PresaleVestingMerkle`) под управлением одного Safe-кошелька `0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A`.

---

## 1. FlyANGT (ERC20)

**Параметры**:
- `name`: `FlyANGT`
- `symbol`: `ANGT`
- `decimals`: 18 (стандарт OZ ERC20)
- `TOTAL_SUPPLY`: `500_000_000 * 10**18`

**Конструктор**: `constructor(address treasury)`
- Минт всех 500M на `treasury`
- Owner = `treasury` (через `Ownable(treasury)`)

**Поведение**: deployer-EOA не получает ни единого токена и не становится owner — Safe владеет всем сразу. Никакого `transferOwnership` после деплоя не нужно.

---

## 2. MerkleAirdrop

**Источник данных**: только off-chain (`RewardTotal` в Postgres flyangt). Каждый адрес имеет агрегированную сумму ANGT за выполненные airdrop-задачи.

### Storage

```solidity
IERC20 public immutable token;
bytes32 public merkleRoot;
uint64  public immutable startTime;     // unix; 0 = no early gate
uint64  public immutable endTime;       // unix; 0 = бесконечный клейм
bool    public started;                 // включается owner-ом, замораживает root
bool    public rootFrozen;
mapping(address => bool) public claimed;
```

### Leaf

```solidity
keccak256(abi.encodePacked(account, amountWei))
```

`amountWei` — сумма в wei (1e18). На фронте/в скрипте: `ethers.parseUnits(humanAmount, 18)`.

### Жизненный цикл

1. **Деплой** (Ignition `MerkleAirdropModule`): передаём `tokenAddress`, `initialRoot=0x00…00`, `startTime`, `endTime`, `initialOwner=Safe`.
2. **`setMerkleRoot(root)`** owner-ом — обновляем корень после генерации `airdrop/merkle.json`.
3. **Перевод ANGT** на адрес контракта (с Safe). Сумма = сумма всех `amount` в `claims.json`.
4. **`start()`** owner-ом — `started=true`, `rootFrozen=true`. С этого момента root заморожен и нельзя его поменять.
5. **`claim(amountWei, proof[])`** — пользователь забирает.
   - `require(started)`
   - `require(endTime == 0 || block.timestamp <= endTime)`
   - `require(!claimed[msg.sender])`
   - проверка merkle proof
   - `claimed[msg.sender] = true`
   - `token.safeTransfer(msg.sender, amount)`
6. **`sweep(to, amount)`** owner-ом — забрать остаток после airdrop. Лочится на `startTime + ADMIN_WITHDRAW_DELAY` (30 дней).

### Скрипты

- [`scripts/generateAirdropClaims.ts`](scripts/generateAirdropClaims.ts) — `RewardTotal` → `airdrop/claims.json` (`[{address, amount: "12345"}]`, amount в целых ANGT)
- [`scripts/buildMerkle.ts`](scripts/buildMerkle.ts) — `claims.json` → `airdrop/merkle.json` (`{root, proofs: { "0x...": {amount, amountWei, proof[]} }}`)

---

## 3. PresaleVestingMerkle

**Источник данных**: гибридный
- **Off-chain** (`PresaleTotal` в Postgres flyangt) — Stripe-покупки
- **On-chain** (`Purchased` events с `0xdd03…Bed0` через Etherscan) — крипто-покупки
- Объединение по `lower(walletAddress)` → итоговая `claimsVesting.json`

Также контракт поддерживает **ручное добавление OTC-инвесторов** owner-ом — без merkle proof.

### Storage

```solidity
IERC20 public immutable token;
uint64 public immutable deployedAt;     // момент деплоя; от него считается ADMIN_WITHDRAW_DELAY

bytes32 public merkleRoot;
bool    public started;                 // активирует claim/activate, freeze-ит root
bool    public rootFrozen;

// Per-user vesting clock — стартует при первой записи токенов на юзера
mapping(address => uint64) public vestingStartOf;

// Merkle-аллокация (один раз на адрес, через activateMerkle)
mapping(address => bool)    public merkleActivated;
mapping(address => uint256) public merkleAllocationWei;

// Admin-аллокация (additive; повторяется при OTC-доливах)
mapping(address => uint256) public adminAllocationWei;

// Сколько уже забрано (по обоим bucket-ам сразу)
mapping(address => uint256) public claimedWei;
```

### Константы

```solidity
DECIMALS         = 1e18
MONTH            = 30 days
DURATION_MONTHS  = 36
DURATION         = 36 * 30 days = 1080 days
ADMIN_WITHDRAW_DELAY = 30 days
```

### Vesting math (per-user clock)

```
totalAllocationWei(u)  = merkleAllocationWei[u] + adminAllocationWei[u]

monthsElapsedOf(u):
    if vestingStartOf[u] == 0 || now < vestingStartOf[u]: return 0
    elapsed = now - vestingStartOf[u]
    m = elapsed / MONTH
    return min(m, DURATION_MONTHS)

vestedWei(u)    = total * monthsElapsed / DURATION_MONTHS
claimableWei(u) = max(0, vestedWei(u) - claimedWei[u])
```

### Когда стартует таймер

`vestingStartOf[u]` устанавливается **только один раз** — при первой записи токенов на этого юзера:
- `activateMerkle()` — если до этого админом не было сделано `addInvestor*` для этого адреса
- `addInvestor*()` — если юзер ещё не активировался по merkle

Доливы не сбрасывают таймер. Если юзер активировал merkle на TGE → его 36 месяцев идут от TGE. Если OTC-инвестор добавлен через 5 месяцев → его 36 месяцев идут от момента добавления.

### Leaf

```solidity
keccak256(abi.encodePacked(account, totalAllocationAmountWei))
```

⚠ В отличие от `MerkleAirdrop`, у этого контракта в `claims.json` **могут быть дробные суммы** (Stripe-покупки часто дают не круглые числа ANGT). `ethers.parseUnits(amount, 18)` корректно конвертирует `"1234.56789"` в wei.

### Жизненный цикл

1. **Деплой** (Ignition `PresaleVestingModule`): `(tokenAddress, initialRoot=0x00…00, initialOwner=Safe)`. `deployedAt = block.timestamp`.
2. **`setMerkleRoot(root)`** owner-ом — обновляем корень после генерации `airdrop/merkleVesting.json`.
3. **Перевод ANGT** на адрес контракта (с Safe). Сумма ≥ сумма всех `claimsVesting.json` + резерв на OTC-инвесторов.
4. **`start()`** owner-ом — `started=true`, `rootFrozen=true`. До этого никто не может ни активировать merkle, ни клеймить.
5. **`activateMerkle(amountWei, proof[])`** — пользователь активирует свою аллокацию.
   - `require(started)`
   - `require(!merkleActivated[msg.sender])`
   - проверка proof
   - `merkleAllocationWei[msg.sender] = amountWei`
   - если `vestingStartOf[msg.sender] == 0` — ставится `block.timestamp` (его старт)
6. **`claim()`** — забрать накопленный анлок. `claim` можно дёргать в любой момент после старта таймера; за каждый прошедший месяц выдаётся 1/36 от total.
7. **`activateAndClaim(amountWei, proof[])`** — комбинация (если юзер активирует и сразу хочет забрать первый месяц).
8. **`addInvestorWei(account, amountWei)`** / `addInvestorHuman` — owner добавляет OTC-инвестора. Аналогично, при первой записи стартует таймер. Долив не сбрасывает.
9. **`addInvestorsWei([], [])`** / `addInvestorsHuman` — батч-версия для массовых OTC.
10. **`fund(amountWei)`** — owner может pull-ом затащить токены через approve+transferFrom. Альтернатива — просто `token.transfer()` на адрес контракта.
11. **`sweep(to, amount)`** owner-ом — лок 30 дней от деплоя контракта. После — забрать остаток.

### View-helper для UI

```solidity
getAccountInfo(account) returns (
    uint256 totalWei,
    uint256 vestedNowWei,
    uint256 claimedSoFarWei,
    uint256 claimableNowWei,
    uint256 monthsElapsedNow,
    uint64  vestingStart,
    uint256 nextUnlockTimestamp
)
```

### Скрипты

- [`scripts/generatePresaleClaims.ts`](scripts/generatePresaleClaims.ts) — Postgres + Etherscan → `airdrop/claimsVesting.json`
- [`scripts/buildMerkleVesting.ts`](scripts/buildMerkleVesting.ts) — `claimsVesting.json` → `airdrop/merkleVesting.json`

---

## 4. Сравнительная таблица merkle-контрактов

| | MerkleAirdrop | PresaleVestingMerkle |
|---|---|---|
| **Источник** | off-chain БД (`RewardTotal`) | off-chain БД (`PresaleTotal`) + on-chain (`Purchased` events) |
| **Leaf** | `keccak256(addr, amountWei)` | `keccak256(addr, amountWei)` |
| **Вход в claim** | `claim(amountWei, proof)` | `activateMerkle(amountWei, proof)` + `claim()` |
| **Дробные суммы** | нет (RewardTotal — `Int`, целые ANGT) | да (Stripe + on-chain → wei с любой точностью) |
| **Раздача** | сразу при claim | по 1/36 в месяц (per-user clock) |
| **Ручной долив админом** | нет | да (`addInvestor*`) |
| **Дедлайн** | `endTime` (0 = ∞) | без дедлайна, only `sweep` через 30 дней |
| **Sweep delay** | от `startTime` | от `deployedAt` |

---

## 5. Ignition модули и параметры

```
ignition/modules/FlyANGT.ts          → FlyANGT(treasury)
ignition/modules/MerkleAirdrop.ts    → useModule(FlyANGT) → MerkleAirdrop(token, root, start, end, owner)
ignition/modules/PresaleVesting.ts   → useModule(FlyANGT) → PresaleVestingMerkle(token, root, owner)
ignition/modules/PresaleModule.ts    → старый Presale (не используется в TGE-флоу)
```

[`ignition/parameters.polygon.json`](ignition/parameters.polygon.json):
```json
{
  "FlyANGTModule":        { "treasury": "0xBBC7Ee…490A" },
  "MerkleAirdropModule":  { "owner": "0xBBC7Ee…490A", "merkleRoot": "0x00…00", "startTime": 0, "endTime": 0 },
  "PresaleVestingModule": { "owner": "0xBBC7Ee…490A", "merkleRoot": "0x00…00" }
}
```

`merkleRoot=0x00…00` — placeholder. Реальный root устанавливается **после** деплоя через `setMerkleRoot(...)` (всё равно owner = Safe). Альтернатива — пересохранить `parameters.polygon.json` с реальным root перед деплоем и задеплоить уже с ним.

---

## 6. Порядок деплоя на Polygon mainnet

1. **Подготовка**:
   - Node 22+ (Hardhat 3 этого требует)
   - В hardhat keystore: `POLYGON_PRIVATE_KEY` (deployer-EOA с MATIC на газ), `POLYGON_RPC_URL`, `AMOY_*` для тестнета
   - `.env`: `POSTGRESQL_DB_URL`, `ETHERSCAN_API_KEY` для скриптов
2. **Локально**:
   ```bash
   npm run compile
   npm run test          # когда напишем тесты для airdrop / vesting
   ```
3. **Snapshot БД** (closed-list):
   ```bash
   POSTGRESQL_DB_URL=… npm run claims:airdrop
   ETHERSCAN_API_KEY=… POSTGRESQL_DB_URL=… npm run claims:presale
   ```
4. **Merkle deriving**:
   ```bash
   npm run merkle:airdrop   # → airdrop/merkle.json
   npm run merkle:presale   # → airdrop/merkleVesting.json
   ```
5. **Деплой токена**:
   ```bash
   npx hardhat ignition deploy ignition/modules/FlyANGT.ts \
     --network polygon \
     --parameters ignition/parameters.polygon.json
   ```
6. **Деплой airdrop + vesting** (используют тот же FlyANGTModule, ignition их соберёт ссылающимися на уже задеплоенный токен):
   ```bash
   npx hardhat ignition deploy ignition/modules/MerkleAirdrop.ts \
     --network polygon --parameters ignition/parameters.polygon.json

   npx hardhat ignition deploy ignition/modules/PresaleVesting.ts \
     --network polygon --parameters ignition/parameters.polygon.json
   ```
7. **С Safe-кошелька** (через Safe Tx Builder в браузере):
   - `MerkleAirdrop.setMerkleRoot(rootAirdrop)`
   - `PresaleVestingMerkle.setMerkleRoot(rootVesting)`
   - `FlyANGT.transfer(MerkleAirdrop, sumAirdrop)`
   - `FlyANGT.transfer(PresaleVestingMerkle, sumVesting + reserveOTC)`
   - `MerkleAirdrop.start()`
   - `PresaleVestingMerkle.start()`
8. **Верификация на Polygonscan** (через ignition-verify или вручную через standard JSON input).
9. **Прописать адреса во flyangt**:
   - `.env`: `ANGT_ADDRESS=0x…`
   - В фронт-коде / `lib/web3/addresses.ts`: адрес airdrop + vesting контрактов
10. **Фронт-страницы клейма** (`/app/claim`, `/app/vesting`) — отдельная задача.

---

## 7. Поведение, которое легко забыть

- **EOA-deployer** ничем не владеет после деплоя. Все `onlyOwner`-функции вызывает Safe.
- **`start()` нужно вызвать явно** на обоих merkle-контрактах. До этого ни клейма, ни активации.
- **`merkleRoot` морозится** при `start()` — поменять root после уже нельзя. Поэтому — сначала `setMerkleRoot`, проверяем, потом `start()`.
- **Дробные суммы** только в vesting-claims, в airdrop-claims — целые числа.
- **Per-user clock** в vesting — дольше всех ждёт OTC-инвестор, добавленный позже всех.
- **GP-кошельки** идут **в обход** vesting-контракта — обычный transfer с Safe, без блокировки (по решению).
- **Старый Presale `0xdd03…Bed0`** остаётся как есть на Polygon — он только источник `Purchased` events для snapshot. Перевыпускать не нужно.
