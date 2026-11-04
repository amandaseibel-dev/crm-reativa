# Projeção parcial desde o 1º dia útil

Regra da gestão para a projeção de fechamento mensal, na Projeção Hora a Hora
(filial e operador) e na TV corporativa.

## Onde isso está (leia primeiro)

| Etapa | Estado |
|---|---|
| **Patch 1** — dia corrente entra na base | **APLICADO EM PRODUÇÃO** em 04/11/2026 pela Amanda. Snapshot de 2026-11 regerado às 08:11. |
| **Patch 2** — base volta a ser o dia fechado, com piso de 1 | **PROPOSTO, não aplicado** — é o `proposta.sql` deste diretório. |
| Tela (selo PROJEÇÃO PARCIAL no CRM e na TV) | Na PR #809, não mesclada. |

O patch 1 em produção é o que faz a tela mostrar, em 04/11, **base 2** e projeção
**R$ 51.028,40**. Foi vendo esse número que a gestão corrigiu a regra.

## A regra (depois do patch 2)

```
base     = dias úteis FECHADOS (de 1º do mês até ONTEM), com piso de 1
projeção = honorário acumulado ÷ base × dias úteis totais do mês
```

- **Base é sempre dia fechado.** O dia corrente está incompleto — boleto e parte
  dos cartões caem em D+1 — e não vira divisor. É a premissa de 2026-08-17, que
  nunca foi errada.
- **Piso de 1.** No 1º dia útil do mês nada fechou ainda; sem o piso a base é 0 e
  a projeção repete o realizado, que era o problema original.
- **Dia não útil** (sábado, domingo, feriado): a base é o que fechou até ontem.
- **Mês encerrado:** base = total, projeção = realizado. Consolidado, como já era.
- **Feriados:** sempre pela tabela `public.feriados` e pelo helper
  `public.dias_uteis(ini, fim)`. Nada de contar dia da semana na mão.

Novembro/2026, 19 dias úteis:

| Dia | Fechados | Base | Projeção |
|---|---|---|---|
| 03/11 (1º dia útil) | 0 | **1** (piso) | 4.073,80 × 19 = **77.402,20** |
| 04/11 (2º dia útil) | 1 (o dia 3) | **1** | 5.371,41 × 19 = **102.056,79** |
| 05/11 (3º dia útil) | 2 (3 e 4) | **2** | acumulado ÷ 2 × 19 |

> Decisão da gestão em 04/11/2026: *"hoje não é o 2 e sim o 1 dia de projeção"*.
> O dia 3 fechou a R$ 5.354,85/dia, que × 19 dá R$ 101.742. Dividir por 2 porque
> o relógio virou cortaria a projeção pela metade sem que nada acontecesse.

### Contar até ontem não é o `- 1` de agosto

A premissa de agosto fazia `dias_uteis(ini, hoje) - 1`, o que em sábado, domingo
e feriado descontava um dia que **já tinha fechado** — em 14/11 (sábado) daria 8
em vez de 9. O patch 2 conta `dias_uteis(ini, hoje - 1)`, que acerta esses dias.

### Efeito a conhecer

O honorário de **hoje** entra no numerador sobre um divisor que **não conta
hoje**. Cada R$ 1 que entra hoje vale R$ 19 de projeção: ela sobe ao longo do dia
e recua na virada, quando o divisor ganha +1. É o preço de a projeção existir já
no 1º dia útil **e** refletir o dinheiro de hoje — os dois pedidos da gestão.

## Onde mora a conta

Três funções em produção, uma linha cada:

| Função | Papel |
|---|---|
| `public.projecao_calcular_filial(text)` | snapshot FILIAL do CRM |
| `public.projecao_calcular_operador(text,text)` | snapshot por operador |
| `public.tv_snapshot_calcular()` | snapshot da TV |

`public.projecao_dashboard` tem o mesmo furo e **não foi tocada de propósito**:
é legado, a tela não a chama, e ainda conta dia útil sem descontar feriado.
Fica anotada.

A conta continua **só no banco**. CRM e TV leem `projecao_parcial` do payload e
não recalculam nada — é o que impede o mesmo número de ter duas contas.

## O campo `projecao_parcial`

Veio no patch 1 e **não muda** no patch 2: é true enquanto hoje for dia útil
dentro do mês de referência. Segue correto — o honorário de hoje está no
numerador, então o número ainda vai mexer.

Na tela:

- **CRM**, gestão, diretoria e rodapé do operador: selo **PROJEÇÃO PARCIAL**, com
  explicação no `title`.
- **TV**, *Resultado do Mês*: `PARCIAL — o dia ainda está em andamento` no card.
- **TV**, *Meta do Mês* e *Magic Number*: ` · PARCIAL` no rodapé da projeção.

## O que não muda

- Valor realizado, recuperado e honorário: nenhuma linha de pagamento é lida de
  outro jeito.
- Metas (`metas_projecao`) e faixas/percentuais de comissão.
- **Dias úteis restantes** conta hoje (o dia ainda vai fechar), então "média
  diária necessária" e "necessário por dia útil" não se movem.
- **Mês fechado**: `v_hoje > v_fim`, a base segue sendo o total. Outubro/2026
  segue 21/21, projeção = realizado. Nenhum fechamento histórico é reescrito.
- `v_hoje` em data local, o payload e os grants: vieram no patch 1; o patch 2 não
  mexe neles.

## Dia corrente é dia local

As funções do CRM usavam `current_date`, que no banco é **UTC** — corrigido no
patch 1 para `America/Sao_Paulo`. Com a base sendo "fechados até ontem" isso
importa mais, não menos: às 21h locais o UTC vira, hoje passaria a contar como
fechado e em 04/11 a base saltaria de 1 para 2 — a projeção cairia de 102.056,79
para 51.028,40 três horas antes da virada de verdade.

`tv_snapshot_calcular` segue com `current_date` no bloco de dias úteis: o cron da
TV roda 11–23 UTC (8h–20h local) e nunca cruza a virada. Pendência própria, fora
deste escopo.

## Validação do patch 2 contra as funções reais (04/11/2026)

Patch e rollback rodados **como transformação de texto sobre
`pg_get_functiondef` das três funções de produção**, em `SELECT` puro — nada
executado, nada gravado:

| Função | Base nova entrou | Patch 1 saiu | Sem desconto de agosto | Conta/payload/dia local intactos | Rollback idêntico | Tamanho |
|---|---|---|---|---|---|---|
| `projecao_calcular_filial` | sim | sim | sim | sim | **sim** | 7.279 → 7.719 |
| `projecao_calcular_operador` | sim | sim | sim | sim | **sim** | 9.487 → 9.927 |
| `tv_snapshot_calcular` | sim | sim | sim | sim | **sim** | 20.028 → 20.182 |

`rollback(patch(def)) = def` **byte a byte** nas três. A volta não é aproximada.

## Sequência segura de aplicação

A **ordem entre banco e tela é livre**: a tela sem o banco não mostra selo (há
teste para o campo ausente), e o banco sem a tela já corrige o número. A
recomendação é **banco primeiro** — é ele que destrava o número.

### 1. Aplicar o SQL — você, no SQL Editor de produção

Rodar `proposta.sql` **inteiro, de uma vez**. É uma transação, e tem **guarda de
pré-condição**: se o patch de 2026-11-03 não estiver aplicado, aborta sem tocar
em nada. Qualquer âncora que não casar também aborta.

Não há janela proibida.

### 2. Conferir a saída do `select` final

Esperado: `regra_nova = t`, `sobrou_patch1 = f`, `tem_flag = t`,
`desconto_de_agosto = f`, e os grants:

```
projecao_calcular_filial    postgres=X/postgres | service_role=X/postgres
projecao_calcular_operador  postgres=X/postgres | service_role=X/postgres
tv_snapshot_calcular        postgres=X/postgres | service_role=X/postgres | authenticated=X/postgres
```

**Os grants são o ponto de atenção:** `CREATE OR REPLACE` devolve execute para
PUBLIC, e o script repõe os de antes. Se `acl_final` vier diferente, parar e avisar.

### 3. Regerar os snapshots

As funções só **calculam**; quem grava é o atualizador.

- **CRM:** um clique em "Atualizar projeção". Recalcula filial + operadores do mês
  selecionado, com lock — dois cliques simultâneos não se atropelam.
- **TV:** `select public.tv_snapshot_atualizar();` ou esperar o cron `85`
  (até 15 min, dias úteis 8h–20h). O cron passa pelo disjuntor
  `sistema_sob_carga()`: com o banco sob carga ele pula a rodada.

Mês fechado não precisa de nada.

### 4. Conferir o número

```sql
select payload->>'dias_uteis_passados'       as base,
       payload->>'dias_uteis_total_mes'      as total,
       payload->>'honorario_mes'             as realizado,
       payload->>'projecao_honorario_filial' as projecao,
       payload->>'projecao_parcial'          as parcial
from public.projecao_snapshot
where escopo = 'FILIAL' and mes_referencia = '2026-11';
```

Em 04/11: `base = 1`, `total = 19`, `parcial = true`, e `projecao = realizado × 19`.
O realizado muda ao longo do dia — o que tem de valer é a **razão
`projecao ÷ realizado = 19`**. A partir de 05/11 a base é 2 e a razão cai para 9,5.

### 5. Tela

Merge da PR #809 e deploy — **sob sua autorização**.

### Se precisar voltar

`rollback.sql` devolve o estado do **patch 1** (dia corrente na base), não o de
agosto. Depois dele, **regerar os snapshots** de novo.

Rollback **não é restore**: PITR não está habilitado. É o inverso determinístico
do patch 2, provado byte a byte.

## Pendência: atualização automática do CRM

- **TV: já é automática** — cron `jobid 85`, `*/15 11-23 * * 1-5`, atrás do
  disjuntor `sistema_sob_carga()`.
- **CRM: manual** (botão). Não existe cron para `projecao_snapshot_atualizar`, e
  isso é desenho: o snapshot manual nasceu para tirar a Projeção do polling
  depois do incidente de saturação do Supabase.

Decisão da gestão em 04/11/2026: **manter como pendência**. Depois que a projeção
nova estiver em funcionamento, definir uma solução que não sobrecarregue o
Supabase. Nada foi preparado nesse sentido.

Para quando for retomado, dois pontos já levantados: cron é alteração de banco com
custo contínuo e precisa de autorização; e `projecao_snapshot_atualizar` autoriza
por allowlist de e-mail lida do JWT — cron não tem JWT, então exigiria um caminho
de serviço próprio (no padrão do job 85, com o mesmo disjuntor).

## Arquivos

| Arquivo | O que é |
|---|---|
| `proposta.sql` | o patch 2, ancorado sobre `pg_get_functiondef`. **Não aplicado.** |
| `rollback.sql` | o inverso exato do patch 2 (volta ao patch 1). |
| `supabase/tests/projecao_parcial_dia_corrente.test.js` | a regra em Postgres real (PGlite) + escopo/segurança da proposta |
| `src/components/tv/tvProjecaoParcial.test.jsx` | selo nas três telas da TV |
| `src/pages/ProjecaoHoraHora.projecaoParcial.test.jsx` | selo no CRM |
