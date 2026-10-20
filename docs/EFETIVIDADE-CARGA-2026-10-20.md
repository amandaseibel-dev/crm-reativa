# Efetividade: carga do recálculo — o que entra, o que não entra e por quê

**20/10/2026.** Medido em produção (`ahattpqrjmhkzsmnbdzs`), somente leitura.
Esta PR entrega **uma** correção e documenta a decisão sobre a outra.

| | nesta PR |
|---|---|
| **Correção B** — o dreno para de descartar pedido que não atendeu | **implementada**, com migration **não aplicada** |
| **Mudança A** — não recalcular os três recortes a cada escrita | **não implementada**; a verificação pedida está abaixo e o resultado foi *mantenha os três* |
| **Alternativa segura de redução de carga** | **proposta por escrito**, não implementada |
| **Fase C** — reescrever as consultas pesadas | fora do escopo, por diretriz |

Nada de produção foi alterado por esta PR. Nenhum agendamento foi tocado: os
jobs 69 (`carteira_efetividade_dreno`, `*/5 * * * *`) e 70
(`carteira_efetividade_hora`, `3 * * * *`) ficam como estão.

---

## 1. A medição que sustenta tudo

Custo de **um** pedido de atualização, lido do ciclo do dreno das 18:25 UTC de
20/10 (`carteira_efetividade_snapshot.duracao_ms`, três blocos × três recortes):

| recorte | composição acadêmica | seis linhas | pendências | total | % |
|---|---|---|---|---|---|
| **2024** | 16.027 ms | 5.987 ms | 1.177 ms | **23.191 ms** | 58,6% |
| **2025** | 9.110 ms | 1.120 ms | 1.553 ms | **11.783 ms** | 29,8% |
| **2026/1** | 1.401 ms | 1.801 ms | 1.417 ms | **4.619 ms** | 11,7% |
| | | | | **39.593 ms** | 100% |

**88% do custo de cada recálculo é coorte fechada** (2024 e 2025), refeita a cada
escrita em `acordos`, `acordos_titulos`, `pagamentos` ou `parcelas`.

Perfil dos dois jobs, média de 7 dias:

| | execuções/dia | CPU/dia | observação |
|---|---|---|---|
| job 69 (dreno) | 288 ticks | 10,4 min | acha trabalho real ~14×/dia, todas entre 08h e 17h BRT; **máx. de uma passada: 134 s**; 2 execuções não bem-sucedidas em 24 h |
| job 70 (rede) | 24 | ~13 min | primeira execução no horário novo: 19:03:00 UTC, `succeeded`, **34,3 s** |

---

## 2. Verificação pedida: dá para identificar o recorte afetado de forma simples e segura?

**Não. Duas razões independentes, e a segunda é decisiva.**

### Razão 1 — estrutural: o gatilho não tem as linhas

Os quatro gatilhos (`trg_efetividade_invalidar_acordos`, `_titulos`,
`_pagamentos`, `_parcelas`) são **AFTER … FOR EACH STATEMENT**. Por desenho: por
linha, a importação do Santander faria centenas de upserts idênticos num arquivo
só — e isso está fixado por teste. Um gatilho por comando **não tem acesso às
linhas alteradas**, então `carteira_efetividade_invalidar` não tem como saber o
recorte e enfileira os três (`unnest(array['2024','2025','2026/1'])`).

Dar acesso às linhas exige `REFERENCING NEW TABLE … OLD TABLE …` nos quatro
gatilhos (DDL nos quatro) **e** uma consulta de mapeamento linha → safra dentro
do caminho de escrita: para `acordos_titulos`, um join em
`prime_titulo_semestre` pelo boleto; para `pagamentos` e `parcelas`, um caminho
mais longo. Isso é exatamente o que a diretriz manda evitar — jogar consulta
para dentro da operação do usuário, no clique do operador e no meio da
importação.

### Razão 2 — de correção: o recorte afetado **não é função da linha alterada**

Em `carteira_em_aberto_por_status_academico`, o ano só entra na **última** CTE
(`ano_pedido`). Antes dela, a CTE `cand` calcula

```sql
sum(saldo) over (partition by aluno_id) as devido_total
```

sobre **2024/1..2025/2 e também sobre títulos de semestre nulo**, e esse
`devido_total` governa a exclusão `coalesce(pj.pago,0) >= c.devido_total`
(`pago_julho`). A CTE `cpf_status` agrupa por **CPF** no universo inteiro.

Consequência prática: **um pagamento de um aluno com títulos em 2024 e em 2025
pode mudar o número dos dois anos** — e pode mudar o número de um ano sem que
nenhuma linha daquele ano tenha sido tocada. Classificar o pedido pela linha
alterada publicaria número velho em um dos recortes. Isso viola a diretriz de
preservar os resultados financeiros, e é por isso que **não** foi implementado.

É o mesmo motivo pelo qual **não se pode empurrar o filtro de ano para dentro**
da consulta: parece otimização e é mudança de número.

### Decisão

**Mantidos os três recortes**, como manda a diretriz 3.

---

## 3. Alternativa segura de redução de carga (proposta, não implementada)

**Porteiro de fonte inalterada.** Antes de computar um bloco,
`carteira_efetividade_recalcular` compararia os **contadores de modificação** das
tabelas de entrada com os contadores gravados junto da última fotografia. Se
nenhuma tabela de entrada sofreu insert, update ou delete desde então, o payload
não pode ter mudado: não recalcula e registra `descartado: fonte inalterada`.

Os contadores vêm de `pg_stat_all_tables` (`n_tup_ins`, `n_tup_upd`,
`n_tup_del`) — estatística **em memória**, custo de microssegundos, sem varrer
tabela nenhuma. É o oposto de uma consulta pesada.

**Por que é seguro, e em que direção ele erra:**

- só pula quando os contadores **provam** que a fonte não se moveu;
- os contadores incluem linhas de transação revertida, então o porteiro erra
  **para o lado de recalcular**, nunca para o lado de pular;
- reset de estatística (`pg_stat_reset()`, reinício) é detectado por contador
  **menor** que o gravado → recalcula.

**Ganho esperado:** o job 70 roda 24×/dia. À noite (14 das 24 execuções) a fonte
tende a estar parada — são as horas em que o dreno não achou trabalho nenhum em
7 dias. Estimativa: **~6 min de CPU por dia**, quase todo fora do expediente.
Durante o expediente raramente pularia, porque operador escrevendo em `casos`,
`parcelas` e `pagamentos` move os contadores. É um ganho modesto e real — não é
o ganho de 88%, que só sai pela fase C.

**Pré-requisito que falta e que eu não fiz aqui:** o censo exato das tabelas de
entrada por bloco. As que já aparecem na régua histórica são onze
(`acordos_titulos`, `acordos`, `acordo_titulo_vinculo`, `parcelas`,
`pagamentos`, `alunos`, `casos`, `solicitacoes_confirmacao_pagamento`,
`prime_titulo_semestre`, `prime_extrato`, `prime_portador_membro`), mas o
caminho de 2026/1 passa por `carteira_2026_1_classificar()`, cuja fonte precisa
ser conferida antes. **Censo incompleto = pular quando devia recalcular = número
velho**, e é por isso que isto é proposta e não código.

---

## 4. Comparação de desempenho da correção B

B **não altera a duração de nenhum recálculo**: não toca nenhuma das três
funções de payload, nenhum índice, nenhuma consulta. O que muda é o que acontece
com o pedido quando o recálculo não aconteceu.

| | hoje | com B |
|---|---|---|
| retorno `ja_em_andamento` | pedido **apagado** sem recalcular | pedido **fica**, recorte sai em `adiados` |
| fotografia | velha, com `atualizacao_pendente` **apagado** | velha, com `atualizacao_pendente` **aceso** |
| correção do número | só na próxima escrita, ou na rede horária | na próxima passada do dreno (≤5 min) |
| custo | zero agora, número velho depois | um recálculo extra no caso raro (4,6 s a 39,6 s) |

**Probabilidade medida.** Com o job 70 em `3 * * * *` (34,3 s a partir do minuto
3) e o dreno em `*/5` (minutos 0, 5, 10…), as duas janelas **não se cruzam** — a
colisão job 70 × dreno, que existia no `*/20`, já saiu. A que resta é dreno ×
dreno, e exige uma passada acima de 300 s: o máximo medido em 24 h foi **134 s**
(45% da janela), com 2 execuções não bem-sucedidas no período. Hoje é
improvável — e é exatamente o caso que o autor do lock previu por escrito em
`20261008113000`: *"o dreno roda de 5 em 5 min e uma passada pode levar mais de
5 min num dia ruim"*.

Em outras palavras: B não é ganho de desempenho, é o fim de uma perda silenciosa
de atualização — e preserva a garantia de ≤5 min para o recorte operacional.

---

## 5. Rollback

`supabase/rollbacks/20261020160509_efetividade_dreno_nao_descarta_pedido_adiado.rollback.sql`
devolve o corpo anterior **palavra por palavra**, copiado de
`20261007234000`. É só DDL, uma função; nenhum dado é alterado em nenhum dos
sentidos, nenhum agendamento precisa ser mexido para reverter. Dois testes
provam o rollback: a chave `adiados` desaparece e o descarte silencioso volta.

---

## 6. Deriva registrada, não corrigida

O agendamento **versionado** de `carteira_efetividade_hora` é `40 * * * *`
(`20261007234000`, e há teste que fixa isso na bancada). A **produção** está em
`3 * * * *` — e estava em `*/20 * * * *` antes de 20/10. A deriva entre repo e
produção é **anterior** a esta PR e não é tocada aqui: mexer nela é assunto de
ledger, não desta correção.
