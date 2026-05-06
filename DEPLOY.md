# FlyANGT TGE — Deployment Guide

Точная пошаговая инструкция по деплою на Polygon mainnet. Для верификации, что всё стоит правильно — см. [SOLIDITY.md](./SOLIDITY.md).

## Перед стартом

```bash
# 1. Node 22+ (Hardhat 3 требует)
node --version    # v22.x.x

# 2. Клонируем
git clone https://github.com/daim43012/ANGT.git
cd ANGT
npm install

# 3. Проверяем что всё собирается
npx hardhat compile
npx hardhat test           # все зелёные

# 4. Готовим credentials в Hardhat keystore
npx hardhat keystore set POLYGON_RPC_URL
# вставляешь свой RPC (свою ноду http://localhost:8545 через ssh-tunnel,
# или публичный https://polygon-rpc.com / Alchemy / Infura)

npx hardhat keystore set POLYGON_PRIVATE_KEY
# приватник deployer-EOA — на нём должно быть ~5 MATIC на газ.
# ВАЖНО: deployer не получает ANGT. Он только платит за газ при деплое.
# Все 500M минтятся на Safe (0xBBC7Ee…490A) автоматически.

# 5. Опционально для verification — Polygonscan API key
npx hardhat keystore set POLYGONSCAN_API_KEY
# https://polygonscan.com/myapikey → Add new
```

---

## ФАЗА 1 — TGE и распределение

### 1.1. Деплой FlyANGT

```bash
npx hardhat ignition deploy ignition/modules/FlyANGT.ts \
  --network polygon \
  --build-profile production \
  --parameters ignition/parameters.polygon.json
```

Ignition спросит подтверждение → `yes`.

После деплоя в логе будет:

```
[ FlyANGTModule ] Successfully deployed
   FlyANGTModule#FlyANGT - 0xABC123...
```

→ **Запиши этот адрес**. Это `ANGT_ADDRESS`.

Проверка состояния:
```bash
# Через любой Polygon-explorer открой адрес
# - На balanceOf(0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A) должно быть 500 000 000 ANGT
# - owner() должно быть 0xBBC7Ee...490A
# - totalSupply() = 500 000 000 ANGT
```

### 1.2. Деплой AllocationRegistry

```bash
npx hardhat ignition deploy ignition/modules/AllocationRegistry.ts \
  --network polygon \
  --build-profile production \
  --parameters ignition/parameters.polygon.json
```

→ запиши `REGISTRY_ADDRESS`.

В конструкторе будет проверена сумма всех `entries` == 500M. Если хоть на 1 wei расхождение — деплой упадёт с `sum != totalSupply`. Это защита от ошибок.

### 1.3. (Можно отложить на потом) Verification на Polygonscan

```bash
npx hardhat ignition verify chain-137
```

Прогонит verification по всем контрактам, задеплоенным через Ignition в этой сессии. Чтобы это работало, должен быть указан `POLYGONSCAN_API_KEY` в keystore.

После verification:
- Polygonscan показывает 🟢 Verified Contract
- TokenSniffer / GoPlus читают исходник, дают полный аудит-скор
- Любой может прочитать твой код прямо в браузере

Можно сделать через минуту, через час, через день — функционально не мешает торгам, только публичной чистоте.

### 1.4. Сгенерируй distribution batch для Safe

```bash
ANGT_ADDRESS=0xABC123...твой_ANGT_адрес npm run safe:distribution
```

Создастся файл `airdrop/safe-batch-distribution.json`. Внутри 6 операций (5 transfer + renounce).

В консоли увидишь итог:
```
Generated Safe distribution batch with 6 transactions:
  1. transfer 100000000 ANGT → GP #1 (0x27c624630fF922Bb675dBFB420C10d745c0f8568)
  2. transfer  50000000 ANGT → GP #2 (0x9adC93CEA02c5DDF5A8fC0139c79708a5bd8f667)
  3. transfer  25000000 ANGT → GP #3 (0x4261f9534A92e3f9bb5ec5fD9484eE3f9332Eb3F)
  4. transfer  25000000 ANGT → Devs  (0x59589d7630077f2eCAf1b44A59EDaF12b1100bdb)
  5. transfer  12500000 ANGT → MM    (0xad98403fe174A46E3E4d0793AF579C23b666EFEd)
  6. renounceOwnership() → FlyANGT

Total transferred: 212500000 ANGT
Treasury keeps:    287500000 ANGT
```

### 1.5. Загрузи batch в Safe и подпишите

1. Открой https://app.safe.global
2. Connect Wallet (любой из 3 GP)
3. Выбери Safe `0xBBC7Ee82284416aaA9C3e6d9C73d7D1f7752490A`
4. **Apps** → **Transaction Builder**
5. **Drag-drop файл** `airdrop/safe-batch-distribution.json`
6. Нажми **Create Batch** или **Send Batch** (название кнопки зависит от версии)
7. **Все 3 GP подписывают** через свои MetaMask/Rabby (приходят уведомления)
8. После последней подписи batch исполняется атомарно одной on-chain транзакцией

После завершения проверь на Polygonscan:
- Safe `0xBBC7Ee…490A` теперь имеет `287 500 000 ANGT`
- GP1, GP2, GP3, Dev, MM получили свои доли
- `FlyANGT.owner()` = `0x0000000000000000000000000000000000000000` (renounced)

### 1.6. Готово — токен живой

Дальше можешь:
- Перевести 100k ANGT с Safe → твой LP-кошелёк → залить ликвидность на Uniswap (см. SOLIDITY.md)
- Анонсить
- Спокойно ждать пока пул стабилизируется

---

## ФАЗА 2 — Открытие Airdrop и Vesting

Делается **когда захочешь** — через час, день, неделю. Никакой срочности.

### 2.1. Деплой MerkleAirdrop и PresaleVestingMerkle

```bash
npx hardhat ignition deploy ignition/modules/MerkleAirdrop.ts \
  --network polygon \
  --build-profile production \
  --parameters ignition/parameters.polygon.json

npx hardhat ignition deploy ignition/modules/PresaleVesting.ts \
  --network polygon \
  --build-profile production \
  --parameters ignition/parameters.polygon.json
```

→ запиши `AIRDROP_ADDRESS` и `VESTING_ADDRESS`.

(Verification аналогично — `npx hardhat ignition verify chain-137`)

### 2.2. Сгенерируй activate batch

```bash
ANGT_ADDRESS=0x...      \
AIRDROP_ADDRESS=0x...   \
VESTING_ADDRESS=0x...   \
VESTING_RESERVE=10000000  \
npm run safe:activate
```

`VESTING_RESERVE` — сколько целых ANGT положить в vesting-контракт **сверх snapshot** для будущих OTC-инвесторов. По умолчанию `0`. Например `10000000` = 10M ANGT резерва (хватит на пол-десятка $50k OTC-сделок).

Создастся `airdrop/safe-batch-activate.json` с 6 операциями:
```
1. transfer 4 400 ANGT (точно по snapshot) → MerkleAirdrop
2. transfer 162 460.7324… + 10M резерв → PresaleVestingMerkle
3. setMerkleRoot 0x4020c2a5… → MerkleAirdrop
4. setMerkleRoot 0x22e849df… → PresaleVesting
5. start() → MerkleAirdrop  (морозит root, открывает claim)
6. start() → PresaleVesting (морозит root, открывает activation)
```

### 2.3. Подпишите batch в Safe

Аналогично шагу 1.5.

После выполнения:
- Юзеры могут идти на сайт и клеймить
- OTC-инвесторов добавляешь через `addInvestorHuman(addr, amount)` — отдельные Safe-транзакции

---

## ФАЗА 3 — Опционально, OTC-инвесторы

Каждый раз когда пришёл OTC-инвестор:

```
1. Считаешь сколько ANGT по цене $0.02:
   $50 000 / 0.02 = 2 500 000 ANGT

2. Если на vesting-контракте уже хватает резерва — пропускай шаг 3

3. Если резерв заканчивается, добавь в batch transfer с Safe:
   FlyANGT.transfer(VESTING_ADDRESS, 2 500 000 * 1e18)

4. В Safe Tx Builder напиши вызов addInvestorHuman:
   Address: VESTING_ADDRESS
   Function: addInvestorHuman
   account: 0x_адрес_инвестора
   amountTokens: 2500000

5. 3 GP подписывают, инвестор записан, его 36-месячный таймер пошёл
```

---

## Что делать если что-то пошло не так

| Проблема | Решение |
|---|---|
| `npx hardhat test` падает | Проверь Node v22+; `rm -rf node_modules && npm install` |
| Ignition deploy падает: "insufficient funds" | На deployer-EOA нужно ≥0.5 MATIC |
| `npm run safe:distribution` ругается на `ANGT_ADDRESS` | Передай `ANGT_ADDRESS=0x...` в env |
| Verification "Already verified" | Норм, ignition verify идемпотентен |
| Safe Tx Builder не видит контракт | Подожди 30-60 сек после verification, чтобы Polygonscan API подтянул ABI |
| После distribution batch баланс Safe не 287.5M | Проверь логи batch'а в Safe history — все ли 6 операций прошли |

---

## Чек-лист готовности перед запуском

- [ ] Repo склонирован, `npm install` прошёл
- [ ] Node 22+
- [ ] `npx hardhat test` → всё зелёное
- [ ] Hardhat keystore: `POLYGON_RPC_URL`, `POLYGON_PRIVATE_KEY`, `POLYGONSCAN_API_KEY`
- [ ] На deployer-EOA ≥ 5 MATIC
- [ ] 3 GP-подписанта Safe онлайн и готовы подписать
- [ ] Список адресов в `parameters.polygon.json` совпадает с реальными личными GP-кошельками
- [ ] Snapshots `airdrop/claims.json` и `airdrop/claimsVesting.json` финальные (если хочешь — пересними)

После каждого ✅ — двигаемся.
