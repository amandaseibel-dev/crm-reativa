# Tabulação de termo físico restrita à gestão — testes

Job `tabulacao-termo-fisico-gestao-sql` no CI (Postgres 17 descartável), na ordem:

1. `01_ambiente.sql`: **simulação** das dependências do Supabase (não é o Supabase real).
2. migração `aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente`.
3. `02_tabulacao.sql`: gestão permitida, operador recusado, ausência de efeitos.
4. rollback `...rollback.sql`.
5. `03_rollback.sql`: trigger removida, catálogo desativado (não apagado), histórico preservado.

## Simulado (não é o Supabase real)

papéis e privilégios padrão de `public`; `auth.jwt()` e `auth.role()` lendo `request.jwt.claims`;
`usuarios` e `app_usuario_ativo()`; `usuario_e_gestao()` com o corpo lido em produção;
`eh_tipo_acionamento()` com a lista lida em produção; catálogo `tabulacoes` e histórico
`aluno_movimentacoes` com colunas de produção, subconjunto de linhas e a policy de INSERT
do operador.

## Não coberto

- PostgREST (o `SET ROLE` vem do PostgREST no Supabase real; aqui é simulado).
- RLS real de `tabulacoes` (na produção a leitura do operador filtra as linhas só-gestão;
  a trigger usa função SECURITY DEFINER para ler o catálogo inteiro, como antes).
- Outros triggers de `aluno_movimentacoes` em produção (ex.: `trg_zz_desfazer_cartao_tabulacao`).
- Staging: inacessível nesta conta.
