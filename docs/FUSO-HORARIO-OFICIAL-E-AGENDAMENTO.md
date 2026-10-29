# Fuso horário oficial e janelas de agendamento

**Decisão da gestão, 21/10/2026.** O horário oficial de toda a automação de
pagamentos, da projeção financeira, da TV ReATIVA, dos registros de execução e
das notificações à operação é **`America/Sao_Paulo`**.

Este documento é o requisito da **etapa seguinte** (agendamento e atualização
automática da projeção e da TV). **Nada aqui foi implementado**: as duas
migrations corretivas da PR #722 não tiveram o escopo alterado e nenhum cron foi
agendado.

---

## 1. O fato que mais importa, medido em 21/10/2026

| medida | valor |
|---|---|
| `current_setting('TimeZone')` do banco | **`UTC`** |
| `log_timezone` | `UTC` |
| **`cron.timezone`** | **`GMT`** |
| `now()` | `2026-10-21 20:18 +00` |
| `now() at time zone 'America/Sao_Paulo'` | `2026-10-21 17:18` |

**Toda expressão passada a `cron.schedule` é interpretada em GMT/UTC, não em
Brasília.** Quem escrever `0 8 * * *` esperando 08h de Brasília agenda, de fato,
**05h de Brasília**. A conversão tem de ser feita à mão na expressão, porque o
pg_cron desta instância não aceita fuso por job.

Brasília é **UTC−3 fixo** — o horário de verão foi extinto em 2019. Ainda assim,
**nas consultas a conversão deve ser sempre pelo NOME do fuso**
(`at time zone 'America/Sao_Paulo'`), nunca por deslocamento fixo (`- interval
'3 hours'`): se o horário de verão voltar, o nome continua certo e o
deslocamento passa a estar errado em silêncio.

### Achado registrado, não auditado

Há **24 jobs ativos com hora fixa**, todos lidos em GMT. Alguns aparentam ter
sido escritos pensando em hora local — por exemplo `nivelamento_automatico_gestao
= 20 9 * * *` dispara às **06:20 de Brasília**, e `acordo_alertas_d2_diario =
30 11 * * *` às **08:30**. Não foram revisados nesta etapa (fora de escopo);
ficam registrados para a etapa de agendamento decidir caso a caso.

Também medido: **65 funções já convertem** para `America/Sao_Paulo` — a
convenção existe e deve ser seguida — e **140 usam `current_date` ou `::date`
sem conversão**, o que é risco latente de fuso já conhecido. Não auditado aqui.

---

## 2. As janelas, convertidas

Janelas pedidas pela gestão, em horário de Brasília, e a expressão de cron
correspondente **em UTC**:

| janela (Brasília) | o que faz | cron (UTC) | dispara (Brasília) |
|---|---|---|---|
| **08:00** | processamento **consolidado** do que acumulou de madrugada | `0 11 * * *` | 08:00 |
| **09:00–20:00** | atualização **a cada hora** | `0 12-23 * * *` | 09:00, 10:00 … 20:00 |
| **20:01–23:59** | **conferência** dos pagamentos recebidos no intervalo | `30 23,0-2 * * *` | 20:30, 21:30, 22:30, 23:30 |
| **00:00–07:59** | **nada roda** — acumula para as 08:00 | — | — |

Conferência da aritmética: UTC = Brasília + 3. Hora 11 UTC = 08h; hora 23 UTC =
20h; horas 0, 1 e 2 UTC = 21h, 22h e 23h do dia anterior em Brasília. A faixa
UTC **03:00–10:59** fica vazia, e é exatamente a madrugada de Brasília.

O minuto é escolha da gestão. Os exemplos usam `:00` na janela horária e `:30`
na de conferência para não coincidir com os 24 jobs já existentes.

---

## 3. Não duplicar baixa nem reprocessar o concluído

O requisito já está atendido pelo que a `20261021195950` construiu — a etapa de
agendamento **não precisa inventar controle novo**, só não desfazer o que existe:

| exigência | onde já é cumprida |
|---|---|
| não reprocessar concluído | a fila exclui `status_conciliacao = 'BAIXADO'` |
| não reabrir o que a gestão decidiu | exclui quem tem `fila_pagamento_sem_vinculo.decisao is not null` |
| não girar em falso | a **espera**: muitas tentativas sem decisão = no máximo uma por janela |
| não duplicar baixa | a decisão é do motor, que já recusa segunda baixa (`PARCELA_JA_PAGA`) |
| duas rodadas não se somarem | `pg_try_advisory_xact_lock`: a segunda sai na hora |
| não perder o acumulado da madrugada | a fila é **derivada do estado**, sem cursor — o que entrou às 03h continua pendente às 08h |

**A janela de acumulação não exige fila própria.** Como a fila é derivada do
estado, "acumular" é simplesmente não rodar: o pagamento que entrar às 02h
aparece na primeira rodada das 08h. O que muda nas 08h é só o **tamanho do
lote**, não a lógica.

---

## 4. Regras para a projeção, a TV e a apresentação

1. **Agendamento:** converter à mão para UTC, como na tabela acima, e escrever o
   horário de Brasília em comentário na própria migration, ao lado da expressão.
2. **Filtro de período:** todo corte por dia, mês ou semestre usa
   `(<coluna> at time zone 'America/Sao_Paulo')::date`, nunca `<coluna>::date`
   cru. `rodou_em`, `conciliacao_em`, `baixado_em` e `criado_em` são
   `timestamptz` — o `::date` cru deles devolve o dia em **UTC**, e das 21h às
   24h de Brasília isso é o dia seguinte.
3. **Apresentação:** todo horário exibido à operação converte explicitamente.
   `vw_fluxo_pagamentos_monitor` hoje devolve `rodou_em` como `timestamptz` cru —
   a etapa de agendamento deve acrescentar a coluna já convertida, sem remover a
   original.
4. **Comparação com "hoje":** seguir a convenção já em produção em 65 funções,
   por exemplo `caso_em_giro_fidelizacao`, que compara com
   `(now() at time zone 'America/Sao_Paulo')::date`.
5. **Teste:** rodar a suíte com `TZ=UTC` antes de empurrar. A máquina local está
   em BRT e o CI em UTC; teste que depende de hora renderizada passa aqui e
   quebra lá. Já aconteceu, e é por isso que os testes desta frente começam com
   `globalThis.process.env.TZ = "UTC"`.

---

## 5. A configuração definitiva, preparada em 21/10/2026

Preparada na migration `20261021225805_fluxo_pagamentos_agendar_brasilia.sql`,
**não aplicada**. Três jobs:

| job | cron (UTC) | Brasília | chamada |
|---|---|---|---|
| `fluxo_pag_consolidado_08h_brt` | `0 11 * * *` | 08:00 | `(25, 45, 8, 24, true)` |
| `fluxo_pag_horario_09_20h_brt` | `0 12-23 * * *` | 09:00–20:00 | `(25, 20, 8, 24, true)` |
| `fluxo_pag_conferencia_noite_brt` | `30 23,0,1,2 * * *` | 20:30–23:30 | `(25, 20, 8, 24, **false**)` |

Parâmetros: `(p_lote, p_segundos, p_tentativas_max, p_espera_horas, p_aplicar)`.
O consolidado das 08h recebe 45 s em vez de 20 porque enfrenta o acumulado da
noite; o teto duro da função é 120 s, conferido a cada pagamento.

**A janela da noite não baixa.** Ela chama com `p_aplicar => false`, e isso não
é promessa de comportamento: desde a `20261021210416` a prévia roda o motor em
subtransação sempre revertida. Para a noite passar a baixar, troque `false` por
`true` **nesse job**, com autorização específica.

**A migration recusa aplicar** se o job 38 estiver ativo, ou se já existir job
agendado para a rodada — os dois agendamentos nunca coexistem.

### Validação pré-ativação: um defeito encontrado e corrigido

A gestão pediu para validar que nenhum registro elegível ficasse de fora.
**Ficaria.** Medido em produção:

| medida | valor |
|---|---|
| pendentes sem decisão da gestão | **386** |
| nunca tentados | **0** |
| com 1 a 7 tentativas | 21 |
| com 8 ou mais | **365** |
| **visíveis** para a rodada, com a espera como exclusão | **21** |
| **retidos** pela espera | **365** |

E a retenção não expirava de forma confiável: `trg_fila_pagamento_tentativa` é
BEFORE UPDATE em `fila_pagamento_sem_vinculo` e, para linha pendente, faz
`ultima_tentativa_em := now()` em **qualquer** update — não só nos da rodada.
Medido: **385 linhas com o mesmo instante** (15:34 BRT), porque um lote de
importação tocou todas de uma vez. Bastava importar um arquivo por dia para a
janela de 24 h nunca abrir.

Corrigido na `20261021223117`: a espera saiu do `where` e virou o **primeiro
critério do `order by`**. O veterano recém-tentado vai para o fim da fila, nunca
para fora. O anti-giro-em-falso passa a ser o **teto de lote**: 25 por rodada em
vez de 386. Vazão: 386 pendentes × 17 disparos/dia ÷ 25 = 425 avaliações/dia,
pouco mais de uma por pendente — a mesma que a espera pretendia, sem inanição.

### Como os filtros distinguem cada categoria

| categoria | como é distinguida | medido hoje |
|---|---|---|
| **pagamento novo** | menos tentativas ⇒ vai primeiro no `order by`. Não há filtro por data | 28 criados nas últimas 24 h |
| **registro noturno** | a fila **não tem filtro de horário**: o que entra às 02h é elegível na rodada das 08h | 0 criados entre 00h e 07h BRT |
| **pendência antiga** | ≥ 8 tentativas ⇒ despriorizada, alcançada por rodízio do mais antigo sem tentar | 365 |
| **concluído** | `status_conciliacao = 'BAIXADO'` sai da fila | 1.262 |
| **decidido pela gestão** | `fila.decisao is not null` nunca volta sozinho | 269 |
| **legado pré-14/09** | `status_conciliacao is null` é invisível por decisão | 8.955 |

"Acumular" a madrugada não exige fila própria: a fila é derivada do estado, e há
teste provando que 30 pendentes em rodadas de 25 cobrem os 30 sem repetir nem
esquecer nenhum.

## 6. O que esta etapa NÃO fez

- Não agendou nenhum cron.
- Não alterou o escopo das duas migrations corretivas da PR #722.
- Não revisou os 24 jobs com hora fixa nem as 140 funções com `::date` cru.
- Não agendou nem ativou nenhum dos três jobs: a migration está preparada e
  **não aplicada**.
- Não alterou `vw_fluxo_pagamentos_monitor` — a coluna já convertida para
  Brasília fica para quando o cron for ativado.
- Não revisou os 24 jobs com hora fixa nem as 140 funções com `::date` cru.
