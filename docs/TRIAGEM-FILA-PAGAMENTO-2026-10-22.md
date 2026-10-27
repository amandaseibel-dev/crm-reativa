# Triagem da fila de pagamentos — medição de 22/10/2026

Somente leitura. Nenhuma migration foi aplicada, nenhum pagamento, acordo,
parcela, baixa, status, etapa, job ou contador de tentativas foi alterado, e os
8.955 pagamentos históricos não foram tocados.

Fonte: produção (`ahattpqrjmhkzsmnbdzs`), 22/10/2026, via `execute_sql` em
leitura. As consultas que produziram cada número estão reproduzidas abaixo.

---

## A partição das 448 pendências

`status_conciliacao` não nulo e diferente de `BAIXADO`. **448 pagamentos,
R$ 377.515,27**, 448 `pagamento_id` distintos.

| Categoria | Subcategoria | n | Valor |
|---|---|---:|---:|
| **ACIONÁVEL PELO ADMINISTRATIVO** | | **87** | **63.730,17** |
| | `ja_paga_conferir_e_encerrar` | 45 | 40.261,10 |
| | `escolher_aluno_sugerido` | 42 | 23.469,07 |
| **AGUARDANDO INFORMAÇÃO DE ACORDO** | | **22** | **27.564,25** |
| | `acordo_ausente_no_crm` | 22 | 27.564,25 |
| **BLOQUEADO POR ETAPA DESATIVADA** | | **265** | **186.318,47** |
| | `consulta_portador` | 265 | 186.318,47 |
| **DIVERGÊNCIA: CONFERÊNCIA HUMANA** | | **74** | **99.902,38** |
| | `decidida_mas_ainda_pendente` | 33 | 83.203,30 |
| | `acordo_sem_parcela_livre` | 23 | 3.894,14 |
| | `acordo_cancelado_fluxo_proprio` | 7 | 4.511,23 |
| | `parcela_paga_antes_da_extracao` | 7 | 3.107,08 |
| | `boleto_reemitido_vencimento_anterior` | 3 | 2.196,08 |
| | `valor_fora_da_faixa` | 1 | 2.990,55 |
| **TOTAL** | | **448** | **377.515,27** |

Zero em `nao_classificado` e zero em `pendente_sem_linha_na_fila`. Os dois
baldes existem na view justamente para que um caso novo apareça em vez de
desaparecer.

### As categorias saem de dados que já existem — três das quatro

| Categoria | Sinal | É coluna? |
|---|---|---|
| Acionável (42) | `fila.sugestoes` jsonb não vazio | **sim** |
| Acionável (45) | motivo `ja estava PAGO antes` + etapa `encerrar_ja_paga_conferida` ligada | motivo + **coluna** |
| Aguardando acordo | motivo `nao esta no CRM` | motivo |
| **Bloqueado por etapa** | `fluxo_pagamentos_config.ligado` + `consulta_portador_em` + motivo | **colunas** + mapa declarado |
| Conferência (33) | `fila.decisao` não nula com status pendente | **sim** |
| Conferência (restantes) | padrões do motivo | motivo |

A categoria 3 é a única que **não existia** nos dados: nenhuma coluna diz "este
motivo depende da etapa X". O elo foi declarado em `_dependencia`, dentro da
view, e cruzado com `fluxo_pagamentos_config` **em tempo de consulta** — religar
a etapa reclassifica sozinho, sem editar SQL. O teste
`supabase/tests/fila_pagamento_triagem.test.js` exerce isso: ligada a etapa, as
265 passam a `AGUARDANDO_INFORMACAO_ACORDO` e o total continua em 448.

**Dado estruturado manda, e a produção mostra por quê:** 42 pendências têm
`sugestoes` preenchido e **apenas 11 mencionam sugestão no texto do motivo**.
Quem lesse o texto perderia 31.

```sql
-- a partição completa, em uma consulta
with cfg as (select etapa, ligado from fluxo_pagamentos_config),
dep as (select * from (values
          ('%API oficial ainda nao foi consultada%','consulta_portador')) d(padrao,etapa)),
base as (
  select p.id, p.status_conciliacao, p.valor_pago,
         f.id fila_id, f.decisao, f.motivo, f.sugestoes, f.consulta_portador_em
    from pagamentos p
    left join fila_pagamento_sem_vinculo f on f.pagamento_id = p.id
   where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO')
select case
         when fila_id is null                        then 'CONFERENCIA|sem_linha'
         when decisao is not null                    then 'CONFERENCIA|decidida_mas_pendente'
         when motivo ilike '%CANCELADO, nao ATIVO%'  then 'CONFERENCIA|acordo_cancelado'
         when jsonb_array_length(coalesce(sugestoes,'[]'::jsonb)) > 0
                                                     then 'ACIONAVEL|escolher_aluno'
         when motivo ilike '%ja estava PAGO antes%'  then 'ACIONAVEL|ja_paga'
         when exists (select 1 from dep d join cfg c on c.etapa = d.etapa
                       where base.motivo ilike d.padrao and c.ligado is false
                         and base.consulta_portador_em is null)
                                                     then 'BLOQUEADO|consulta_portador'
         when motivo ilike '%nao esta no CRM%'       then 'AGUARDANDO|acordo_ausente'
         else 'CONFERENCIA|outro' end as cat,
       count(*), sum(valor_pago)::numeric(14,2)
  from base group by 1 order by 3 desc;
```

---

## Por que algumas pendências acumulam centenas de tentativas

Três mecanismos somados. Nenhum é defeito isolado; juntos produzem repetição
sem saída.

### 1 · O contador conta toques, não tentativas de resolução

`_fila_pagamento_tentativa()` é `BEFORE INSERT OR UPDATE` em
`fila_pagamento_sem_vinculo`. Em qualquer UPDATE de linha com `decisao is null`:

```
new.ultima_tentativa_em   := now();
new.quantidade_tentativas := coalesce(old.quantidade_tentativas, 1) + 1;
```

Qualquer escrita na linha incrementa o contador, tenha havido tentativa de
resolução ou não.

### 2 · A espera reordena, nunca exclui

Em `fluxo_pagamentos_incremental`, `p_tentativas_max` (8) e `p_espera_horas`
(24) entram no `ORDER BY`, não no `WHERE`: o veterano recém-tentado vai para o
**fim** da fila, nunca para fora. Foi correção deliberada da PR #722 — excluir
por `ultima_tentativa_em` deixava 365 de 386 de fora, exatamente porque o
gatilho acima reescreve esse campo em qualquer update.

Com 448 pendentes, 13 rodadas que aplicam por dia e lote de 25 (≈325
escolhas/dia), cada pendência volta a ser tentada a cada ~1,4 dia,
indefinidamente. O contador cresce com o calendário.

### 3 · Para o maior grupo, a saída está fechada

265 das 448 (59% das linhas, 49% do dinheiro) dependem de `consulta_portador`,
**desligada pela gestão desde 15/09/2026**. E `consulta_portador_em` é **nulo em
329 de 329** pendências `AGUARDANDO_ACORDO`: a consulta que o próprio motivo
promete (*"a API oficial ainda nao foi consultada para este caso — a rodada
horaria consulta"*) **nunca aconteceu para nenhuma**.

Para essas 265, o número real de consultas tentadas é **zero**, não 229.

```sql
-- distribuição dos toques e a data da primeira tentativa
select width_bucket(f.quantidade_tentativas, 0, 250, 10) faixa,
       min(f.quantidade_tentativas) de, max(f.quantidade_tentativas) ate,
       count(*) n, min(f.primeira_tentativa_em)::date primeira
  from pagamentos p
  join fila_pagamento_sem_vinculo f on f.pagamento_id = p.id and f.decisao is null
 where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO'
 group by 1 order by 1;
-- máximo 263 toques, primeira tentativa em 25/09/2026
```

### O efeito observável

A rodada devolve `baixados: 0` em **todas** as execuções desde 21/10, e
`pendentes` subiu 420 → 448 ao longo de 22/10. É aritmética: o orçamento de 25
vagas/hora é gasto majoritariamente numa categoria sem porta de saída.

**Esta frente não corrige isso.** Mexer no orçamento da rodada é alterar
`fluxo_pagamentos_incremental`, e a autorização desta etapa é explícita em não
tocar jobs, etapas nem tentativas. A triagem torna o fato legível e mensurável;
a decisão sobre o orçamento é separada.

---

## Os três casos de divergência de vencimento — investigação (somente leitura)

**Minha hipótese anterior estava errada.** Eu havia sugerido "erro sistemático
de um mês no número da parcela". Conferido caso a caso, não é isso.

Os 4 últimos dígitos do boleto são **sequência de emissão da ULBRA**, não índice
de `parcelas.numero`. Quando uma parcela é reemitida, a sequência avança e o
vencimento continua sendo o da parcela antiga. O motor compara o vencimento do
arquivo com o da parcela cujo `boleto` casa — e acusa divergência. O que ele
detecta é **boleto reemitido**, não erro de dado.

As três consequências são diferentes entre si:

### Acordo 63061 — boleto `50630610003`, R$ 226,40 pago em 09/10

| Parcela | Vencimento | Valor | Status | Boleto | origem_baixa |
|---:|---|---:|---|---|---|
| 2 | 04/09/2026 | 219,08 | **PAGO** (pago_em 22/10) | **nulo** | **nulo** |
| 3 | 04/10/2026 | 219,08 | **VENCIDA** | 50630610003 | nulo |

O vencimento do arquivo (04/09) é o da parcela 2, que está PAGO sem boleto e sem
`origem_baixa` — marcada à mão em 22/10. A parcela 3, que carrega o boleto
efetivamente pago, segue **VENCIDA**. O acordo tem uma parcela paga sem crédito
e uma parcela com crédito ainda em cobrança. **Divergência real.**

### Acordo 66483 — boleto `50664830003`, R$ 1.030,87 pago em 02/10

Parcela 2 (vence 17/10, boleto `...0002`) está **PAGO com `pago_em` 09/10** — e o
pagamento em questão entrou em **02/10**, antes dessa baixa, sob o boleto
`...0003` (parcela 3, que vence 17/11 e está A_VENCER). O vencimento do arquivo
(17/10) aponta para a parcela 2, já quitada por outro crédito. **Suspeita de
pagamento em duplicidade.**

### Acordo 70820 — boleto `50708200002`, R$ 938,81 pago em 30/09

Parcela 1 (vence 30/09, boleto `...0001`) está **PAGO com `pago_em` 28/08**,
antes do próprio vencimento. O pagamento entrou em 30/09 sob o boleto `...0002`
(parcela 2, vence 30/10, A_VENCER). O vencimento do arquivo (30/09) é o da
parcela 1, já quitada. **Suspeita de pagamento em duplicidade.**

**Exposição somada das duas suspeitas: R$ 1.969,68.** Nenhuma ação foi tomada —
os três entram na triagem como `boleto_reemitido_vencimento_anterior`, em
conferência humana, sem ação sugerida.

```sql
-- os três casos e as parcelas dos acordos
select a.numero_ulbra, a.status, pa.numero, pa.vencimento, pa.valor,
       pa.status, pa.boleto, pa.origem_baixa, pa.pago_em
  from acordos a join parcelas pa on pa.acordo_id = a.id
 where a.numero_ulbra in ('63061','66483','70820')
 order by a.numero_ulbra, pa.numero;
```

---

## As 33 que ninguém vê

33 pendências (R$ 83.203,30) têm decisão registrada na fila — `FEITO` 9,
`RESOLVIDO_AUTOMATICO` 19, `ENCERRADO_GESTAO` 5 — e o `status_conciliacao` do
pagamento **nunca saiu de pendente**.

O mesmo predicado as exclui dos dois lados:

```sql
and not exists (select 1 from fila_pagamento_sem_vinculo fd
                 where fd.pagamento_id = p.id and fd.decisao is not null)
```

Está em `pagamentos_sem_aluno` (a tela) **e** em `fluxo_pagamentos_incremental`
(a rodada). Decididas, saem da tela; decididas, a rodada as pula. Ninguém as vê
e ninguém as reprocessa.

A view **não herda** esse predicado — herdando, a categoria de conferência
nasceria vazia por construção. Elas aparecem num bloco só de leitura, sem ação:
o que falta ali é conferência, não ação nova.

---

## O que esta frente NÃO fez

- Não aplicou migration. `20261023000700_fila_pagamento_triagem.sql` existe no
  repositório e é executada **apenas** pelo teste, num banco efêmero.
- Não religou `consulta_portador` nem nenhuma outra etapa — apenas **leu**
  `fluxo_pagamentos_config`.
- Não alterou os jobs 73/74/75, nem `fluxo_pagamentos_incremental`, nem
  `_fila_pagamento_tentativa`, nem `pagamentos_sem_aluno`, nem `pagamentos_trava`.
- Não deu baixa, não mudou status, não mexeu em contador de tentativas.
- Não tocou os 8.955 pagamentos com `status_conciliacao` nulo (R$ 12.306.066,08,
  01/07 a 11/09). A view os exclui pelo mesmo `where` da rodada, e há teste
  provando que um pagamento de status nulo não entra.
- Não criou mecanismo de decisão para acordo cancelado: os 7 casos são contados
  e marcados `acordo_cancelado_fluxo_proprio`, com `acao_sugerida` nula. A
  decisão continua na frente da PR #694.

## Limite conhecido, dito em vez de escondido

`pagamentos_trava(uuid[])` já devolve 12+ códigos de trava precisos e é chamada
pela tela a cada carregamento, mas **cobre só `AGUARDANDO_ACORDO`** — devolve
`FORA_DO_ESCOPO` para os outros 111. A distribuição real entre esses códigos
**não foi medida**: o portão da função exige gestão ou `service_role`, e a
conexão usada nesta medição é nenhum dos dois (`42501`). Se a triagem for
ancorar nos códigos de trava em vez dos padrões de motivo, essa medição precisa
vir antes, feita de uma sessão logada como gestão.
