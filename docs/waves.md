# Waves 1–100 — quem aparece, quanto, e como escala

> Gerado de `packages/shared/src/config.js` + `sim/waves.js`.
> Regenerar: `node tools/gen-waves-doc.mjs`. Não editar à mão.

## Como a força escala

Três coisas crescem de forma independente:

**1. HP de todo inimigo, por wave** — `ENEMY.HP_PER_WAVE`

```
hp = hp_base × (1 + 0.16 × (wave - 1)) × fator_jogadores
```

| wave | multiplicador de HP (1 jogador) |
| --- | --- |
| 1 | ×0.9 |
| 10 | ×2.1 |
| 25 | ×4.1 |
| 50 | ×7.5 |
| 75 | ×10.9 |
| 100 | ×14.3 |

**2. Velocidade** — `ENEMY.SPEED_PER_WAVE` = 0.006 por wave (na wave 100 ≈ +59%).

**3. Dano** — NÃO cresce dentro do ciclo 1–100. Só sobe a cada volta:
`+35%` por volta completa (wave 101+ = volta 1, 201+ = volta 2…).

### Estágios (tier) — inimigos comuns crescem de porte

| estágio | HP | dano | pontos | xp | escala | aparece de |
| --- | --- | --- | --- | --- | --- | --- |
| 1 (normal) | ×1 | ×1 | ×1 | ×1 | ×1 | sempre |
| 2 | ×2.2 | ×1.4 | ×2 | ×2 | ×1.7 | wave 11 |
| 3 | ×4.2 | ×1.8 | ×4 | ×4 | ×2.5 | wave 16 |

A chance de um spawn sair em estágio 2 ou 3:

| wave | chance estágio 2 | chance estágio 3 | teto de estágio 3 na wave |
| --- | --- | --- | --- |
| 10 | 0% | 0% | 0 |
| 15 | 18% | 0% | 0 |
| 20 | 35% | 6% | 1 |
| 30 | 45% | 12% | 2 |
| 40 | 45% | 12% | 2 |
| 60 | 45% | 12% | 2 |
| 80 | 45% | 12% | 2 |
| 100 | 45% | 12% | 2 |

> Tetos: estágio 2 no máximo 45% da wave, estágio 3 12%.

### Mini-boss e boss

- **Mini-boss** (waves 5, 15, … 95): HP ×7, dano ×1.8, escala ×2.4, vale 6× pontos, conta 3 brechas.
- **Boss** (waves 10, 20, … 100): escala ×3 (alguns multiplicam por cima), 110 pontos, 260 xp, conta 5 brechas. HP/dano/armadura são por boss — ver a tabela deles abaixo.

### Número de jogadores

| jogadores | HP dos inimigos | quantidade | pontos ganhos |
| --- | --- | --- | --- |
| 1 | ×0.85 | ×0.8 | ×1.4 |
| 2 | ×1 | ×1 | ×1.1 |
| 3 | ×1.2 | ×1.3 | ×0.95 |
| 4 | ×1.4 | ×1.55 | ×0.85 |

## Inimigos base (antes de qualquer multiplicador)

| inimigo | HP | vel | dano | pts | xp | notas |
| --- | --- | --- | --- | --- | --- | --- |
| Esqueleto | 40 | 2.3 | 8 | 4 | 7 | — |
| Zumbi | 95 | 1.5 | 14 | 6 | 11 | — |
| Fantasma | 33 | 2.9 | 6 | 5 | 9 | voa (ignora o labirinto) |
| Morcego | 38 | 3.6 | 7 | 6 | 10 | voa (ignora o labirinto) |
| Arqueiro Esq. | 55 | 2.1 | 11 | 8 | 13 | ataca à distância 6.5 |
| Lança-Osso | 30 | 1.2 | 7 | 7 | 11 | ataca à distância 5.5 |
| Orc | 190 | 1.9 | 22 | 10 | 18 | — |
| Vampiro | 290 | 2.5 | 30 | 16 | 30 | pula muros |
| Coveiro | 1150 | 1.6 | 40 | 110 | 260 | invoca, **só como boss** |
| Aranha | 70 | 2.7 | 12 | 7 | 12 | **só como boss** |
| Dragão | 420 | 2 | 36 | 20 | 40 | voa (ignora o labirinto), **só como boss** |

> Vampiros a partir da wave 61 ganham magia de sangue fraca (dano 14, alcance 6, cura 35% do dano).

## Composição por fase

Waves normais sorteiam da mistura da fase. Os números são **pesos**:
peso 4 aparece 4× mais que peso 1.

**Waves 1–4** — Zumbi 100%

**Waves 5–10** — Zumbi 60%, Esqueleto 40%

**Waves 11–20** — Zumbi 52%, Esqueleto 34%, Lança-Osso 14%

**Waves 21–30** — Zumbi 33%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 13%

**Waves 31–39** — Arqueiro Esq. 29%, Zumbi 24%, Fantasma 24%, Esqueleto 12%, Lança-Osso 12%

**Waves 40–40** — Arqueiro Esq. 25%, Zumbi 20%, Fantasma 20%, Morcego 15%, Esqueleto 10%, Lança-Osso 10%

**Waves 41–50** — Orc 41%, Arqueiro Esq. 17%, Fantasma 17%, Morcego 12%, Esqueleto 7%, Lança-Osso 7%

**Waves 51–60** — Fantasma 34%, Orc 14%, Arqueiro Esq. 10%, Morcego 10%, Vampiro 10%, Zumbi 7%, Esqueleto 7%, Lança-Osso 7%

**Waves 61–70** — Morcego 25%, Vampiro 25%, Orc 13%, Arqueiro Esq. 9%, Fantasma 9%, Zumbi 6%, Esqueleto 6%, Lança-Osso 6%

**Waves 71–100** — Arqueiro Esq. 15%, Fantasma 15%, Morcego 15%, Orc 15%, Vampiro 15%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9%

## Wave a wave

`qtd` é o total de mobs comuns com 1 jogador (fórmula: 8 + wave × 2.6, × fator de jogadores).

| wave | tipo | qtd | quem vem | estágios |
| --- | --- | --- | --- | --- |
| 1 | normal | 8 | Zumbi 100% | 1: 100% |
| 2 | normal | 11 | Zumbi 100% | 1: 100% |
| 3 | normal | 13 | Zumbi 100% | 1: 100% |
| 4 | normal | 15 | Zumbi 100% | 1: 100% |
| **5** | mini | 10 | **Zumbi azul** + 10× Zumbi | fixo |
| 6 | normal | 19 | Zumbi 60%, Esqueleto 40% | 1: 100% |
| 7 | normal | 21 | Zumbi 59%, Esqueleto 41% | 1: 100% |
| 8 | normal | 23 | Zumbi 61%, Esqueleto 39% | 1: 100% |
| 9 | normal | 25 | Zumbi 60%, Esqueleto 40% | 1: 100% |
| **10** | BOSS | 8 | **Coveiro** + 4× Zumbi, 4× Esqueleto | fixo |
| 11 | normal | 29 | Zumbi 51%, Esqueleto 35%, Lança-Osso 14% | 1: 96% · 2: 4% |
| 12 | normal | 31 | Zumbi 52%, Esqueleto 34%, Lança-Osso 14% | 1: 93% · 2: 7% |
| 13 | normal | 33 | Zumbi 51%, Esqueleto 34%, Lança-Osso 14% | 1: 89% · 2: 11% |
| 14 | normal | 36 | Zumbi 52%, Esqueleto 34%, Lança-Osso 14% | 1: 86% · 2: 14% |
| **15** | mini | 10 | **Arqueiro Esq.** + 10× Arqueiro Esq. | fixo |
| 16 | normal | 40 | Zumbi 52%, Esqueleto 35%, Lança-Osso 14% | 1: 78% · 2: 21% · 3: 1% |
| 17 | normal | 42 | Zumbi 52%, Esqueleto 35%, Lança-Osso 13% | 1: 74% · 2: 24% · 3: 1% |
| 18 | normal | 44 | Zumbi 51%, Esqueleto 35%, Lança-Osso 14% | 1: 71% · 2: 27% · 3: 2% |
| 19 | normal | 46 | Zumbi 52%, Esqueleto 35%, Lança-Osso 14% | 1: 67% · 2: 31% · 3: 2% |
| **20** | BOSS | 100 | **A Horda Zumbi** — 50 verdes, 35 azuis (revivem 2×), 15 vermelhos (revivem 3×) | — |
| 21 | normal | 50 | Zumbi 33%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 13% | 1: 59% · 2: 39% · 3: 2% |
| 22 | normal | 52 | Zumbi 34%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 14% | 1: 58% · 2: 40% · 3: 2% |
| 23 | normal | 54 | Arqueiro Esq. 33%, Zumbi 33%, Esqueleto 20%, Lança-Osso 13% | 1: 53% · 2: 45% · 3: 2% |
| 24 | normal | 56 | Zumbi 33%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 13% | 1: 54% · 2: 44% · 3: 2% |
| **25** | mini | 10 | **Fantasma azul** + 10× Fantasma | fixo |
| 26 | normal | 60 | Zumbi 34%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 13% | 1: 54% · 2: 43% · 3: 3% |
| 27 | normal | 63 | Zumbi 33%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 14% | 1: 54% · 2: 43% · 3: 3% |
| 28 | normal | 65 | Arqueiro Esq. 34%, Zumbi 33%, Esqueleto 20%, Lança-Osso 13% | 1: 53% · 2: 43% · 3: 3% |
| 29 | normal | 67 | Zumbi 33%, Arqueiro Esq. 33%, Esqueleto 20%, Lança-Osso 14% | 1: 54% · 2: 43% · 3: 3% |
| **30** | BOSS | 12 | **Tiro Cego** + 3× Esqueleto, 2× Esqueleto (est. 2), 1× Esqueleto (est. 3), 2× Arqueiro Esq., 1× Arqueiro Esq. (est. 2), 2× Lança-Osso, 1× Lança-Osso (est. 2) | fixo |
| 31 | normal | 71 | Arqueiro Esq. 29%, Zumbi 24%, Fantasma 23%, Lança-Osso 12%, Esqueleto 12% | 1: 54% · 2: 44% · 3: 3% |
| 32 | normal | 73 | Arqueiro Esq. 29%, Fantasma 24%, Zumbi 23%, Lança-Osso 12%, Esqueleto 12% | 1: 54% · 2: 43% · 3: 3% |
| 33 | normal | 75 | Arqueiro Esq. 29%, Fantasma 24%, Zumbi 23%, Lança-Osso 12%, Esqueleto 12% | 1: 53% · 2: 44% · 3: 3% |
| 34 | normal | 77 | Arqueiro Esq. 29%, Fantasma 24%, Zumbi 23%, Esqueleto 12%, Lança-Osso 12% | 1: 53% · 2: 44% · 3: 3% |
| **35** | mini | 10 | **Orc azul** + 10× Orc | fixo |
| 36 | normal | 81 | Arqueiro Esq. 30%, Zumbi 24%, Fantasma 23%, Esqueleto 12%, Lança-Osso 11% | 1: 54% · 2: 44% · 3: 2% |
| 37 | normal | 83 | Arqueiro Esq. 30%, Zumbi 24%, Fantasma 23%, Esqueleto 12%, Lança-Osso 12% | 1: 53% · 2: 44% · 3: 2% |
| 38 | normal | 85 | Arqueiro Esq. 29%, Zumbi 24%, Fantasma 23%, Esqueleto 12%, Lança-Osso 12% | 1: 54% · 2: 44% · 3: 2% |
| 39 | normal | 88 | Arqueiro Esq. 30%, Zumbi 23%, Fantasma 23%, Lança-Osso 12%, Esqueleto 12% | 1: 54% · 2: 44% · 3: 2% |
| **40** | BOSS | 6 | **Zé do Caixão** + 6× Morcego | fixo |
| 41 | normal | 92 | Orc 41%, Arqueiro Esq. 17%, Fantasma 17%, Morcego 13%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 42 | normal | 94 | Orc 41%, Arqueiro Esq. 17%, Fantasma 16%, Morcego 13%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 43 | normal | 96 | Orc 41%, Arqueiro Esq. 17%, Fantasma 16%, Morcego 12%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 44 | normal | 98 | Orc 41%, Fantasma 17%, Arqueiro Esq. 16%, Morcego 13%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| **45** | mini | 10 | **Vampiro** + 10× Vampiro | fixo |
| 46 | normal | 102 | Orc 41%, Arqueiro Esq. 17%, Fantasma 16%, Morcego 12%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 47 | normal | 104 | Orc 42%, Arqueiro Esq. 17%, Fantasma 17%, Morcego 12%, Lança-Osso 6%, Esqueleto 6% | 1: 54% · 2: 44% · 3: 2% |
| 48 | normal | 106 | Orc 41%, Fantasma 17%, Arqueiro Esq. 17%, Morcego 12%, Lança-Osso 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 49 | normal | 108 | Orc 41%, Fantasma 17%, Arqueiro Esq. 16%, Morcego 13%, Esqueleto 7%, Lança-Osso 6% | 1: 54% · 2: 44% · 3: 2% |
| **50** | BOSS | 6 | **Brutus** + 3× Orc, 2× Orc (est. 2), 1× Orc (est. 3) | fixo |
| 51 | normal | 112 | Fantasma 35%, Orc 14%, Morcego 11%, Vampiro 10%, Arqueiro Esq. 10%, Zumbi 7%, Esqueleto 7%, Lança-Osso 7% | 1: 54% · 2: 44% · 3: 2% |
| 52 | normal | 115 | Fantasma 34%, Orc 14%, Morcego 11%, Vampiro 10%, Arqueiro Esq. 10%, Lança-Osso 7%, Esqueleto 7%, Zumbi 7% | 1: 54% · 2: 44% · 3: 2% |
| 53 | normal | 117 | Fantasma 34%, Orc 14%, Arqueiro Esq. 11%, Vampiro 10%, Morcego 10%, Lança-Osso 7%, Zumbi 7%, Esqueleto 7% | 1: 54% · 2: 44% · 3: 2% |
| 54 | normal | 119 | Fantasma 34%, Orc 14%, Vampiro 11%, Arqueiro Esq. 10%, Morcego 10%, Zumbi 7%, Esqueleto 7%, Lança-Osso 7% | 1: 54% · 2: 44% · 3: 2% |
| **55** | mini | 10 | **Zumbi vermelho (revive 2×)** + 10× Zumbi | fixo |
| 56 | normal | 123 | Fantasma 34%, Orc 14%, Vampiro 11%, Morcego 10%, Arqueiro Esq. 10%, Zumbi 7%, Esqueleto 7%, Lança-Osso 7% | 1: 54% · 2: 44% · 3: 2% |
| 57 | normal | 125 | Fantasma 34%, Orc 14%, Arqueiro Esq. 10%, Morcego 10%, Vampiro 10%, Zumbi 7%, Esqueleto 7%, Lança-Osso 7% | 1: 54% · 2: 44% · 3: 2% |
| 58 | normal | 127 | Fantasma 34%, Orc 14%, Morcego 11%, Vampiro 10%, Arqueiro Esq. 10%, Esqueleto 7%, Lança-Osso 7%, Zumbi 7% | 1: 54% · 2: 45% · 3: 2% |
| 59 | normal | 129 | Fantasma 34%, Orc 14%, Arqueiro Esq. 11%, Vampiro 10%, Morcego 10%, Lança-Osso 7%, Esqueleto 7%, Zumbi 7% | 1: 54% · 2: 44% · 3: 2% |
| **60** | BOSS | 8 | **Abobrado** + 5× Fantasma, 3× Fantasma (est. 2) | fixo |
| 61 | normal | 133 | Vampiro 25%, Morcego 25%, Orc 13%, Arqueiro Esq. 9%, Fantasma 9%, Lança-Osso 6%, Zumbi 6%, Esqueleto 6% | 1: 54% · 2: 45% · 3: 2% |
| 62 | normal | 135 | Morcego 25%, Vampiro 25%, Orc 12%, Fantasma 10%, Arqueiro Esq. 9%, Esqueleto 6%, Lança-Osso 6%, Zumbi 6% | 1: 54% · 2: 44% · 3: 1% |
| 63 | normal | 137 | Vampiro 25%, Morcego 25%, Orc 12%, Fantasma 10%, Arqueiro Esq. 9%, Zumbi 6%, Lança-Osso 6%, Esqueleto 6% | 1: 54% · 2: 44% · 3: 1% |
| 64 | normal | 140 | Vampiro 25%, Morcego 25%, Orc 13%, Arqueiro Esq. 10%, Fantasma 9%, Lança-Osso 6%, Esqueleto 6%, Zumbi 6% | 1: 54% · 2: 44% · 3: 1% |
| **65** | mini | 10 | **Arqueiro Esq. + Lança-Osso** + 5× Arqueiro Esq., 5× Lança-Osso | fixo |
| 66 | normal | 144 | Vampiro 25%, Morcego 25%, Orc 13%, Arqueiro Esq. 9%, Fantasma 9%, Esqueleto 6%, Lança-Osso 6%, Zumbi 6% | 1: 54% · 2: 44% · 3: 1% |
| 67 | normal | 146 | Morcego 25%, Vampiro 25%, Orc 12%, Arqueiro Esq. 9%, Fantasma 9%, Lança-Osso 6%, Esqueleto 6%, Zumbi 6% | 1: 54% · 2: 45% · 3: 1% |
| 68 | normal | 148 | Vampiro 25%, Morcego 25%, Orc 13%, Arqueiro Esq. 10%, Fantasma 9%, Esqueleto 6%, Lança-Osso 6%, Zumbi 6% | 1: 54% · 2: 45% · 3: 1% |
| 69 | normal | 150 | Vampiro 25%, Morcego 25%, Orc 13%, Arqueiro Esq. 9%, Fantasma 9%, Esqueleto 6%, Lança-Osso 6%, Zumbi 6% | 1: 54% · 2: 45% · 3: 1% |
| **70** | BOSS | 6 | **Drácula** + 2× Vampiro, 4× Morcego (est. 2) | fixo |
| 71 | normal | 154 | Fantasma 15%, Morcego 15%, Vampiro 15%, Orc 15%, Arqueiro Esq. 15%, Lança-Osso 9%, Esqueleto 9%, Zumbi 9% | 1: 55% · 2: 44% · 3: 1% |
| 72 | normal | 156 | Morcego 15%, Vampiro 15%, Fantasma 15%, Orc 15%, Arqueiro Esq. 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 54% · 2: 44% · 3: 1% |
| 73 | normal | 158 | Morcego 15%, Orc 15%, Arqueiro Esq. 15%, Fantasma 15%, Vampiro 15%, Lança-Osso 9%, Esqueleto 9%, Zumbi 9% | 1: 54% · 2: 45% · 3: 1% |
| 74 | normal | 160 | Morcego 15%, Orc 15%, Arqueiro Esq. 15%, Fantasma 15%, Vampiro 15%, Lança-Osso 9%, Esqueleto 9%, Zumbi 9% | 1: 54% · 2: 44% · 3: 1% |
| **75** | mini | 10 | **Fantasma vermelho** + 10× Fantasma | fixo |
| 76 | normal | 164 | Arqueiro Esq. 15%, Orc 15%, Morcego 15%, Fantasma 15%, Vampiro 15%, Esqueleto 9%, Zumbi 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 77 | normal | 167 | Arqueiro Esq. 15%, Morcego 15%, Vampiro 15%, Fantasma 15%, Orc 15%, Lança-Osso 9%, Zumbi 9%, Esqueleto 9% | 1: 54% · 2: 44% · 3: 1% |
| 78 | normal | 169 | Fantasma 15%, Morcego 15%, Vampiro 15%, Orc 15%, Arqueiro Esq. 15%, Esqueleto 9%, Lança-Osso 9%, Zumbi 9% | 1: 54% · 2: 45% · 3: 1% |
| 79 | normal | 171 | Arqueiro Esq. 15%, Vampiro 15%, Orc 15%, Fantasma 15%, Morcego 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 54% · 2: 44% · 3: 1% |
| **80** | BOSS | 0 | **Viúva Negra** + _sozinho_ | fixo |
| 81 | normal | 175 | Arqueiro Esq. 15%, Fantasma 15%, Vampiro 15%, Morcego 15%, Orc 14%, Lança-Osso 9%, Zumbi 9%, Esqueleto 9% | 1: 54% · 2: 45% · 3: 1% |
| 82 | normal | 177 | Morcego 15%, Arqueiro Esq. 15%, Orc 15%, Vampiro 15%, Fantasma 14%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 83 | normal | 179 | Vampiro 15%, Arqueiro Esq. 15%, Fantasma 15%, Morcego 15%, Orc 15%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 84 | normal | 181 | Orc 15%, Morcego 15%, Vampiro 15%, Fantasma 15%, Arqueiro Esq. 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 54% · 2: 45% · 3: 1% |
| **85** | mini | 10 | **Orc vermelho** + 10× Orc | fixo |
| 86 | normal | 185 | Fantasma 15%, Orc 15%, Morcego 15%, Arqueiro Esq. 15%, Vampiro 15%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 87 | normal | 187 | Fantasma 15%, Morcego 15%, Vampiro 15%, Arqueiro Esq. 15%, Orc 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 54% · 2: 44% · 3: 1% |
| 88 | normal | 189 | Arqueiro Esq. 15%, Fantasma 15%, Morcego 15%, Vampiro 15%, Orc 15%, Lança-Osso 9%, Zumbi 9%, Esqueleto 9% | 1: 54% · 2: 45% · 3: 1% |
| 89 | normal | 192 | Orc 15%, Morcego 15%, Vampiro 15%, Arqueiro Esq. 15%, Fantasma 15%, Lança-Osso 9%, Esqueleto 9%, Zumbi 9% | 1: 55% · 2: 44% · 3: 1% |
| **90** | BOSS | 0 | **Dragão das Trevas** + _sozinho_ | fixo |
| 91 | normal | 196 | Fantasma 15%, Orc 15%, Vampiro 15%, Morcego 15%, Arqueiro Esq. 15%, Esqueleto 9%, Zumbi 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 92 | normal | 198 | Morcego 15%, Arqueiro Esq. 15%, Vampiro 15%, Orc 15%, Fantasma 15%, Lança-Osso 9%, Zumbi 9%, Esqueleto 9% | 1: 54% · 2: 45% · 3: 1% |
| 93 | normal | 200 | Orc 15%, Fantasma 15%, Vampiro 15%, Arqueiro Esq. 15%, Morcego 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 54% · 2: 45% · 3: 1% |
| 94 | normal | 202 | Morcego 15%, Arqueiro Esq. 15%, Vampiro 15%, Orc 15%, Fantasma 15%, Zumbi 9%, Lança-Osso 9%, Esqueleto 9% | 1: 55% · 2: 45% · 3: 1% |
| **95** | mini | 10 | **Coveiro + Coveiro + Coveiro** + 5× Zumbi, 5× Esqueleto | fixo |
| 96 | normal | 206 | Fantasma 15%, Vampiro 15%, Arqueiro Esq. 15%, Morcego 15%, Orc 14%, Lança-Osso 9%, Esqueleto 9%, Zumbi 9% | 1: 54% · 2: 45% · 3: 1% |
| 97 | normal | 208 | Fantasma 15%, Vampiro 15%, Orc 15%, Arqueiro Esq. 15%, Morcego 15%, Esqueleto 9%, Lança-Osso 9%, Zumbi 9% | 1: 54% · 2: 45% · 3: 1% |
| 98 | normal | 210 | Arqueiro Esq. 15%, Orc 15%, Fantasma 15%, Morcego 15%, Vampiro 15%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| 99 | normal | 212 | Vampiro 15%, Orc 15%, Fantasma 15%, Arqueiro Esq. 15%, Morcego 14%, Zumbi 9%, Esqueleto 9%, Lança-Osso 9% | 1: 54% · 2: 45% · 3: 1% |
| **100** | BOSS | 1 | **Sombra do Herói** + 1 sombra menor por classe presente | fixo |

## Bosses — força

Multiplicadores sobre o corpo que cada um usa, já com o HP da wave por cima.

| wave | boss | corpo | ×HP | ×dano | armadura | escala | poder |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | **Coveiro** | Coveiro | 2.6 | 1.5 | 25% | ×3 |  |
| 20 | **A Horda Zumbi** | Zumbi | 1 | 1 | — | ×3 | 100 zumbis |
| 30 | **Tiro Cego** | Arqueiro Esq. | 34 | 3.2 | 25% | ×3 | acerta todos com flechas |
| 40 | **Zé do Caixão** | Vampiro | 7.5 | 2.2 | 25% | ×3 | 2 pulos encadeados |
| 50 | **Brutus** | Orc | 18 | 3.2 | 45% | ×3 |  |
| 60 | **Abobrado** | Fantasma | 46 | 1.6 | 20% | ×3 | abóbora em área |
| 70 | **Drácula** | Vampiro | 11 | 2.4 | 30% | ×3 | 2 pulos encadeados, magia de sangue em TODOS |
| 80 | **Viúva Negra** | Aranha | 34 | 3 | 35% | ×6 | veneno, teias que lentificam |
| 90 | **Dragão das Trevas** | Dragão | 5.5 | 3.2 | 35% | ×3.9000000000000004 | sopro de fogo |
| 100 | **Sombra do Herói** | Orc | 12 | 1.2 | 40% | ×3 | copia o herói + skill dele a cada 15s |

### Efeito real, com o HP da wave aplicado (1 jogador)

| wave | boss | HP final | dano |
| --- | --- | --- | --- |
| 10 | Coveiro | 6.201 | 60 |
| 20 | A Horda Zumbi | _100 zumbis fracos_ | — |
| 30 | Tiro Cego | 8.965 | 35 |
| 40 | Zé do Caixão | 13.385 | 66 |
| 50 | Brutus | 25.698 | 70 |
| 60 | Abobrado | 13.471 | 10 |
| 70 | Drácula | 32.646 | 72 |
| 80 | Viúva Negra | 27.594 | 36 |
| 90 | Dragão das Trevas | 29.924 | 115 |
| 100 | Sombra do Herói | ≈ 60s do dano do herói | 26 |

## Depois da wave 100

O arco 1–100 recomeça: wave 101 = composição da wave 1, wave 110 = Coveiro de novo. A quantidade de mobs e o ritmo seguem a posição **dentro do ciclo** (senão a wave 200 tentaria colocar 500 inimigos). A dificuldade extra vem do HP, que cresce sem teto com o número bruto da wave, mais +35% de dano por volta.

