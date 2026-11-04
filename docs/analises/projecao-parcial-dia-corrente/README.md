# Projeção de fechamento por dias úteis encerrados

Regra da gestão para a projeção mensal, na Projeção Hora a Hora (filial e
operador) e na TV corporativa.

## Onde isso está (leia primeiro)

| Etapa | Estado |
|---|---|
| **Patch 1** — dia corrente entra na base | **APLICADO EM PRODUÇÃO** em 04/11/2026 pela Amanda. Snapshot de 2026-11 regerado às 08:11. |
| **Patch 2** — projeção só por dias fechados | **PROPOSTO, não aplicado** — é o `proposta.sql` deste diretório. |
| Tela | Na PR #809, não mesclada. |

O patch 1 em produção é o que faz a tela mostrar, em 04/11, base 2 e projeção
R$ 51.028,40. Foi vendo esse número que a gestão fechou a regra definitiva.

## A regra

```
numerador = honorário dos dias úteis FECHADOS (1º do mês até ONTEM)
divisor   = quantidade desses mesmos dias úteis fechados
projeção  = numerador ÷ divisor × dias úteis totais do mês
```

- **Numerador e divisor cobrem exatamente o mesmo período**, encerrado até
  ontem, em horário de Brasília. Sem piso artificial.
- **O honorário recebido hoje continua no realizado** e nos cartões de "hoje",
  mas **não entra na projeção** até o dia fechar.
- **Sem nenhum dia fechado** (1º dia útil do mês) **não existe projeção**: o
  campo vai nulo e a tela diz *"Aguardando fechamento do primeiro dia útil"*.
- **Mês encerrado:** base = total, projeção = realizado. Consolidado, como já era.
- **Feriados:** sempre pela tabela `public.feriados` e pelo helper
  `public.dias_uteis(ini, fim)`.

Novembro/2026, 19 dias úteis (21 dias de semana menos Finados em 02, segunda, e
Consciência Negra em 20, sexta):

| Dia | Dias fechados | Projeção |
|---|---|---|
| 03/11 (1º dia útil) | 0 | *Aguardando fechamento do primeiro dia útil* |
| 04/11 | 1 (o dia 3, R$ 5.354,85) | 5.354,85 × 19 = **R$ 101.742,15** |
| 05/11 | 2 (dias 3 e 4) | acumulado dos dois ÷ 2 × 19 |

**A projeção é estável dentro do dia.** Como o numerador não tem o dinheiro de
hoje, ela não infla ao longo do dia nem recua na virada: muda uma vez por dia,
no fechamento. É isso que se confere para saber que a regra está certa.

### Por que não é o `- 1` da premissa de agosto

A premissa de 2026-08-17 descontava um dia do divisor (`dias_uteis(ini,hoje) - 1`)
mas mantinha o **numerador do mês inteiro**, incluindo hoje — misturava dois
períodos. E o desconto cego tirava um dia que já tinha fechado em sábado,
domingo e feriado (em 14/11 daria 8 em vez de 9). Aqui o corte é o mesmo nos
dois lados: `até ontem`.

## Onde mora a conta

| Função | Papel |
|---|---|
| `public.projecao_calcular_filial(text)` | snapshot FILIAL do CRM |
| `public.projecao_calcular_operador(text,text)` | snapshot por operador |
| `public.tv_snapshot_calcular()` | snapshot da TV |

`public.projecao_dashboard` tem o mesmo furo e **não foi tocada de propósito**:
é legado, a tela não a chama, e ainda conta dia útil sem descontar feriado.

A conta continua **só no banco**. CRM e TV leem o payload e não recalculam nada.

## O campo `projecao_aguardando_fechamento`

Substitui `projecao_parcial`, que deixou de fazer sentido: a projeção não é mais
parcial, porque não contém o dia em andamento. É `true` quando não há nenhum dia
útil fechado no mês.

Na tela:

| Onde | Com dia fechado | Sem dia fechado |
|---|---|---|
| CRM — gestão e diretoria | o valor + "Projeção de fechamento" | caixa azul *"Aguardando fechamento do primeiro dia útil"* |
| CRM — rodapé do operador | "Pelos dias úteis encerrados, fecha em X" | *"Aguardando fechamento do primeiro dia útil"* |
| TV — Resultado do Mês | o valor no card | *"Aguardando fechamento do 1º dia útil"* no lugar do valor |
| TV — Meta do Mês e Magic Number | "Projeção de fechamento X" no rodapé | *"Aguardando fechamento do 1º dia útil"* |

## O que não muda (indicadores financeiros preservados)

- **Realizado, recuperado e honorário do mês** — `v_hon_mes` segue intacto, e os
  cartões de "hoje" continuam mostrando o dinheiro de hoje.
- **Metas, faixas, percentuais e comissão** — `v_du_pass` só é usado na projeção
  e no payload, em nenhum outro cálculo.
- **Dias úteis restantes** (conta hoje, que ainda vai fechar) e portanto "média
  diária necessária" e "necessário por dia útil".
- **`v_hoje` em data local e os grants** — vieram no patch 1.
- **Mês encerrado** — outubro/2026 segue 21/21, projeção = realizado. Nenhum
  fechamento histórico é reescrito.

Duas notas honestas:

- **`media_diaria` e `media_diaria_honorarios` da TV** mantêm a fórmula que já
  tinham (mês corrente ÷ `v_du_ate`). Como `v_du_ate` volta a ser o dia fechado,
  elas voltam ao valor que tinham **antes do patch 1** — restauração, não
  mudança nova. Nenhuma fórmula de indicador foi reescrita.
- **`_tv_meta_obj`**: com a projeção nula no 1º dia útil, o campo `situacao` das
  metas da TV cai no ramo final e diz "Abaixo do ritmo". É o mesmo texto que ele
  já mostra no começo do mês hoje, então não é regressão — mas fica anotado,
  porque corrigir isso é mexer em outra função.

## Validação do patch 2 contra as funções reais (04/11/2026)

Patch e rollback rodados **como transformação de texto sobre
`pg_get_functiondef` das três funções de produção**, em `SELECT` puro — nada
executado, nada gravado:

| Função | Divisor até ontem | Numerador do mesmo período | `projecao_parcial` saiu | Realizado intacto | Rollback idêntico | Tamanho |
|---|---|---|---|---|---|---|
| `projecao_calcular_filial` | sim | sim | sim | sim | **sim** | 7.279 → 7.683 |
| `projecao_calcular_operador` | sim | sim | sim | sim | **sim** | 9.487 → 9.999 |
| `tv_snapshot_calcular` | sim | sim | sim | sim (média diária intacta) | **sim** | 20.028 → 20.530 |

`rollback(patch(def)) = def` **byte a byte** nas três.

Todas as âncoras foram conferidas como presentes e únicas no corpo atual antes
de montar o patch.

## Sequência segura de aplicação

A **ordem entre banco e tela é livre**: sem o campo no payload a tela cai no
caminho "mostra o número" (há teste para o campo ausente), e o banco sem a tela
já corrige a projeção. A recomendação é **banco primeiro**.

### 1. Aplicar o SQL — você, no SQL Editor de produção

Rodar `proposta.sql` **inteiro, de uma vez**. É uma transação, com **guarda de
pré-condição**: se o patch de 2026-11-03 não estiver aplicado, aborta sem tocar
em nada. Qualquer âncora que não casar também aborta.

### 2. Conferir a saída do `select` final

Esperado: `regra_nova = t`, `sobrou_patch1 = f`, `tem_campo_novo = t`,
`sobrou_parcial = f`, e os grants:

```
projecao_calcular_filial    postgres=X/postgres | service_role=X/postgres
projecao_calcular_operador  postgres=X/postgres | service_role=X/postgres
tv_snapshot_calcular        postgres=X/postgres | service_role=X/postgres | authenticated=X/postgres
```

**Os grants são o ponto de atenção:** `CREATE OR REPLACE` devolve execute para
PUBLIC, e o script repõe os de antes. Se `acl_final` vier diferente, parar e avisar.

### 3. Regerar os snapshots

- **CRM:** um clique em "Atualizar projeção".
- **TV:** `select public.tv_snapshot_atualizar();` ou o cron `85` (até 15 min,
  dias úteis 8h–20h), que passa pelo disjuntor `sistema_sob_carga()`.

### 4. Conferir o número

```sql
select payload->>'dias_uteis_passados'                as base_fechada,
       payload->>'dias_uteis_total_mes'               as total,
       payload->>'honorario_mes'                      as realizado,
       payload->>'projecao_honorario_filial'          as projecao,
       payload->>'projecao_aguardando_fechamento'     as aguardando
from public.projecao_snapshot
where escopo = 'FILIAL' and mes_referencia = '2026-11';
```

Em 04/11: `base_fechada = 1`, `total = 19`, `aguardando = false`,
`projecao = 101742.15`.

A prova de que a regra está certa é mais forte que o valor: **clique em
"Atualizar projeção" duas vezes com intervalo de uma hora**. O realizado muda, a
projeção não. Ela só se move no fechamento do dia.

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
Supabase. **Nada foi preparado nesse sentido.**

Dois pontos já levantados, para quando for retomado: cron é alteração de banco
com custo contínuo e precisa de autorização; e `projecao_snapshot_atualizar`
autoriza por allowlist de e-mail lida do JWT — cron não tem JWT, então exigiria
um caminho de serviço próprio, no padrão do job 85.

Com a regra nova, a pressa é menor: a projeção só muda uma vez por dia, então um
clique por dia já entrega o número correto.

## Arquivos

| Arquivo | O que é |
|---|---|
| `proposta.sql` | o patch 2, ancorado sobre `pg_get_functiondef`. **Não aplicado.** |
| `rollback.sql` | o inverso exato do patch 2 (volta ao patch 1). |
| `supabase/tests/projecao_dia_fechado.test.js` | a regra em Postgres real (PGlite), com histórico dia a dia + escopo/segurança da proposta |
| `src/components/tv/tvProjecaoFechada.test.jsx` | as três telas da TV |
| `src/pages/ProjecaoHoraHora.projecaoFechada.test.jsx` | o aviso no CRM |
