# Proposta de aplicação — resumo de caixa e saldo por semestre (PR #966)

Status: PENDENTE. Nada aqui foi aplicado em produção nem registrado no ledger.
Head de referência: `8f4800b33e587eb75385089f030557c17f488746`.

## Artefatos (SHA-256 integral)

- Migration `20261115130000_efetividade_caixa_resumo_semestre.sql`:
  `babaa64f3553f1e29f74a34e05a54deecdb9927ba5d52c4802413e20460c9924`
- Rollback `docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql`:
  `4bf1b0ffe2dd009809fc929b13ac336cce0d09541f48663f8181c0022fdb88b5`

## Registro M1 (criado só na aprovação, por PR própria)

Linha de `docs/seguranca/migracoes-aprovadas.tsv`, com 6 colunas separadas por TAB:
`ahattpqrjmhkzsmnbdzs` · `20261115130000_efetividade_caixa_resumo_semestre` · `babaa64f…c9924` ·
`amanda.seibel@aelbra.com.br` · `expira_em` = momento da aprovação + 30 min (UTC) · `pendente`.

A janela de 30 minutos cobre a chamada de aplicação. Se expirar, a linha é recriada por nova aprovação.

## Executor

Única executora: a sessão principal, sob a autorização da Amanda. Nenhum agente aplica migration.

## Sequência de implantação

1. Revisão e merge da PR #966 pela pessoa autorizada (não pela sessão).
2. PR de registro M1 com a linha acima, revisada e mesclada.
3. Banco, dentro da janela: aplicar a migration; conferir que a função existe com o SHA da migration;
   conferir `has_function_privilege` (authenticated sim, anon não).
4. Validação no banco: rodar o resumo como gestão ativa autorizada e comparar com os números abaixo.
5. Frontend, só depois do passo 4: a tela chama a RPC ao abrir o bloco "Comparar". Sem a RPC, o bloco mostra erro,
   sem afetar o resto da página.
6. PR que muda o status para `aplicada`, com a versão gerada pelo servidor.

## Rollback

- Banco: `docs/rollbacks/efetividade-caixa-resumo-semestre-rollback.sql` (`drop function if exists`).
  Não toca em dados nem na view.
- Frontend: reverter o commit que monta `ComparativoSemestres2026` no bloco de comparativo.

## Números conferidos (leitura, 15/11/2026)

Medidos em produção, pela consulta do anexo em `docs/seguranca/medicao-caixa-resumo-2026-11-15.md`:

| | 2026/1 | 2026/2 |
|---|---|---|
| Carteira original | R$ 21.710.447,29 (fotografia, desatualizada) | R$ 17.232.872,41 (10.822 títulos) |
| Saldo em aberto | R$ 9.055.032,58 (fotografia) | R$ 16.042.642,07 (inclui R$ 7.232.872,33 em conferência) |
| Negociado | R$ 4.535.961,61 | R$ 1.232.903,01 |
| Caixa confirmado | R$ 535.206,14 (639) | R$ 653.066,80 (594) |
| Pendente de classificação | R$ 3.314.532,12 (1.340) | R$ 120.444,29 (84) |
| % recuperado por caixa | 2,5% | 3,8% |

O SELECT da RPC sobre as fontes reais foi rodado em leitura, com limite de 30 s. Levou menos de 0,5 s e devolveu os
mesmos números acima. Essa execução foi do SELECT, não da função, que ainda não existe em produção.

## Resultados de stub (não são números de produção)

Os testes em `supabase/tests/efetividade_caixa_resumo_semestre` usam dados fixos (carteira 2.100, caixa 100,
percentual 4,8%) e não provam a execução contra a view real.

## Limites conhecidos

- A fotografia de 2026/1 está com atualização pendente.
- O percentual é caixa confirmado identificado ÷ carteira original, não recuperação total.
- Custo do classificador de 2026/2 por leitura não medido.
- Não há registro no ledger nesta etapa.
