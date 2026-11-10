# Reconciliação de identidade do espelho ULBRA (prévia)

Pacote: migration `20261110130000_ulbra_identidade_propagada` (pendente, não aplicada).

## Prévia (somente leitura, 10/11/2026)
- Conversas que mudam de estado com a migration: **1** de 7.
- Atendimentos que mudam de estado: **0** de 7.
- A conversa afetada tem vínculo ativo `alta_cpf` criado em 09/11/2026 (cobranca06) e foi gravada pela última vez em 08/11/2026.

## Reconciliação (DML, exige aprovação)
Depois da migration, a reconciliação é uma alteração de dados sobre as linhas listadas acima, feita **pelos gatilhos** (sem SQL manual de linha única):
```sql
-- toca só as linhas afetadas; o gatilho BEFORE recalcula a identidade
update public.ulbra_conversas c set aluno_status = aluno_status
 where (exists (select 1 from public.ulbra_vinculos v where v.ulbra_cliente_id = c.ulbra_cliente_id and v.desvinculado_em is null and v.confianca = 'alta_cpf'))
    <> (c.aluno_status = 'vinculado');
update public.ulbra_atendimentos a set aluno_status = aluno_status
 where (exists (select 1 from public.ulbra_vinculos v where v.ulbra_cliente_id = a.ulbra_cliente_id and v.desvinculado_em is null and v.confianca = 'alta_cpf'))
    <> (a.aluno_status = 'vinculado');
```
A prévia acima deve ser refeita imediatamente antes da execução.

## Limites da prova
Os testes em `supabase/tests/ulbra_identidade.test.js` rodam em PGlite com stubs fiéis de `ulbra_vinculos` e `alunos`. Não são o Postgres 17 do CI nem o banco real. A concorrência é sequencial. Prova de isolamento com dados reais não está coberta por estes testes.

## O que permanece corrigido após o rollback
- O rollback da migration `20261110130000` remove gatilhos e funções. **Não reverte** `aluno_id` e `aluno_status` já reconciliados. Eles ficam como estão até uma decisão própria de reverter.
- O rollback da migration `20261110140000` (Central com vínculo ativo) recria a autorização anterior. Não altera dados.
- Não há ajuste manual de linha única: a reconciliação é feita pelos gatilhos, sobre o conjunto da prévia.

## Efeito sobre datas e avisos
- A reconciliação **não altera** `ultima_mensagem_em`, `ultima_mensagem_cliente_em` nem qualquer data de mensagem.
- Corrigir um vínculo **não gera** aviso de mensagem nova: o sino e as notificações só reagem a mensagem coletada depois da correção, e a classificação de resposta do aluno não muda.

## Concorrência
Testada em PostgreSQL 17 (job `ulbra-identidade-concorrencia`), com duas sessões reais, nos dois sentidos: coleta primeiro e vínculo depois; vínculo primeiro e coleta depois; revogação primeiro e coleta depois; coleta com vínculo e revogação concorrente.
