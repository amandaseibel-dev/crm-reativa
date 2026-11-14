# NÃO APLICAR: 20261016200000 e 20261016200500

As duas migrations ao lado deste arquivo **nunca foram aplicadas em produção e
não devem ser**:

- `20261016200000_giro_executor_grava_movimentacao_administrativa.sql`
- `20261016200500_giro_2026_10_backfill_movimentacao_administrativa.sql`

Elas continuam no repositório porque a catraca de migrations não permite
alterar, apagar ou renomear arquivo que já está no branch base
(`I1-MIGRATION-ALTERADA`, `I2-MIGRATION-APAGADA`, `I3-MIGRATION-RENOMEADA`), e a
orientação da própria catraca é escrever uma migration **nova** com a correção.

## O que havia de errado

As duas usavam `aluno_movimentacoes.lote_id` como identificador do giro. Esse
campo não é um lote genérico: tem chave estrangeira para
`acoes_massivas_lotes`, a tabela de lotes de **ação massiva**.

A tentativa de aplicar o backfill em 16/10/2026 falhou exatamente nisso, e
falhou bem — a transação inteira reverteu, nada foi gravado e a versão não
chegou a ser registrada:

```
violates foreign key constraint "aluno_movimentacoes_lote_id_fkey"
DETAIL: Key (lote_id)=(437f434b-e781-4357-a5ef-3fcd8e9d4770)
        is not present in table "acoes_massivas_lotes"
```

A origem do erro foi inferir a semântica do campo pelo índice único
`ux_aluno_mov_lote_aluno (lote_id, aluno_id)` sem conferir as constraints da
tabela — uma variável só, sem cruzamento.

**A saída errada, registrada para ninguém repetir:** criar uma linha em
`acoes_massivas_lotes` para o giro faria o giro contar como ação massiva nos
relatórios de penetração e cobertura. O problema seria trocado por um pior.

## O que vale no lugar

- `20261016210000_giro_movimentacao_coluna_propria.sql` — cria
  `aluno_movimentacoes.giro_simulacao_id` (nula) e o índice único parcial
  `ux_aluno_mov_giro_aluno (giro_simulacao_id, aluno_id)`, e ensina o executor
  do giro a gravar o evento administrativo por essa coluna.
- `20261016210500_giro_2026_10_backfill_movimentacao.sql` — o backfill dos
  3.665 registros do giro de 16/10, pela coluna nova.

A migration de correção trata os dois estados possíveis da função em produção:
se um dia a 20261016200000 for aplicada por engano, ela **substitui** o `INSERT`
por `lote_id` em vez de achar que o trabalho já está feito.

## A lição que ficou no teste

O teste de comportamento original passou porque o duplo em PGlite criou
`aluno_movimentacoes` com o índice único, mas **sem a chave estrangeira**. Ele
validou um mundo que não era o de produção. O duplo agora espelha as constraints
reais, inclusive a FK para `acoes_massivas_lotes`, e há um caso que prova que a
abordagem antiga seria recusada pelo banco.
