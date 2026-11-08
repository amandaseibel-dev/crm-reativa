-- REGIME DEPOIS DO PILOTO: o que a migration de fim de piloto tem de fazer,
-- e a prova de que a regra de operador continua funcionando quando voltar.
--
-- POR QUE ESTE ARQUIVO EXISTE. O piloto de observacao fechou duas coisas:
-- o EXECUTE de `assumir`/`dispensar` para `authenticated`, e o ramo de operador
-- das duas policies de leitura. As provas dessas regras ja existiam e NAO foram
-- descartadas: foram movidas para ca. Este arquivo aplica o regime (o overlay
-- abaixo E a migration de fim de piloto, em miniatura) e reexecuta as
-- afirmacoes. Se o regime quebrar, o CI acusa agora, nao no dia da volta.
--
-- Roda DEPOIS de 03 (piloto) e ANTES do rollback.
\set ON_ERROR_STOP on

-- ============================================================================
-- OVERLAY DE FIM DE PILOTO -- o conteudo da futura migration
-- ============================================================================
grant execute on function public.ulbra_atendimento_assumir(text)         to authenticated;
grant execute on function public.ulbra_atendimento_dispensar(text, text) to authenticated;

drop policy if exists ulbra_conversas_leitura on public.ulbra_conversas;
create policy ulbra_conversas_leitura on public.ulbra_conversas
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and (
      usuario_e_gestao()
      or exists (
        select 1 from public.casos c
         where c.aluno_id = ulbra_conversas.aluno_id
           and lower(c.operador_email) = app_email()
      )
    )
  );

drop policy if exists ulbra_atendimentos_leitura on public.ulbra_atendimentos;
create policy ulbra_atendimentos_leitura on public.ulbra_atendimentos
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and (
      usuario_e_gestao()
      or (
        lower(coalesce(responsavel_email, '')) = app_email()
      )
      or (
        responsavel_email is null
        and destino_motivo in ('CARTEIRA', 'RODIZIO')
        and lower(coalesce(destino_email, '')) = app_email()
        and dispensado_em is null
      )
    )
  );

-- ============================================================================
-- PROVAS DE REGIME (as mesmas que 03 tinha antes do piloto)
-- ============================================================================

-- leitura: cada um ve o seu
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 1, 'REGIME: op1 le so a conversa do aluno da sua carteira (1)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 1, 'REGIME: op1 le so o atendimento sugerido a ele (x1)');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 1, 'REGIME: op2 le so a conversa do aluno da sua carteira (1)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 2, 'REGIME: op2 le os seus dois atendimentos (x2, x4)');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 3, 'REGIME: gestao le todas as conversas (3)');
  select count(*) into n from public.ulbra_atendimentos;
  perform public.afirmar(n = 4, 'REGIME: gestao le todos os atendimentos, inclusive conferencia (4)');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'inativo@x', false);
do $$ declare n int; begin
  select count(*) into n from public.ulbra_conversas;
  perform public.afirmar(n = 0, 'REGIME: usuario inativo nao le conversa');
end $$;
reset role;

-- assumir: dois donos, carteira, conferencia e a excecao da gestao
set role authenticated; select set_config('teste.email', 'op1@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x1');
  perform public.afirmar((r->>'ok')::boolean, 'REGIME: op1 assume o atendimento sugerido a ele (x1)');
  r := public.ulbra_atendimento_assumir('x2');
  perform public.afirmar(r->>'motivo' = 'E_DA_CARTEIRA_DE_OUTRO', 'REGIME: op1 NAO assume a carteira de op2 (x2)');
  r := public.ulbra_atendimento_assumir('x3');
  perform public.afirmar(r->>'motivo' = 'IDENTIDADE_NAO_CONFIRMADA', 'REGIME: op1 NAO assume conferencia (x3)');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'op2@x', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x1');
  perform public.afirmar(r->>'motivo' = 'JA_ASSUMIDO' and r->>'responsavel' = 'op1@x',
    'REGIME: op2 chega depois e recebe JA_ASSUMIDO com o nome de quem chegou primeiro');
end $$;
reset role;

set role authenticated; select set_config('teste.email', 'amanda.seibel@aelbra.com.br', false);
do $$ declare r jsonb; begin
  r := public.ulbra_atendimento_assumir('x2');
  perform public.afirmar((r->>'ok')::boolean, 'REGIME: gestao assume a carteira de op2 (excecao da gestao)');
end $$;
reset role;

-- ============================================================================
-- VOLTA AO PILOTO: este arquivo nao deixa o regime ligado para quem vem depois
-- ============================================================================
revoke all on function public.ulbra_atendimento_assumir(text)         from public, anon, authenticated;
revoke all on function public.ulbra_atendimento_dispensar(text, text) from public, anon, authenticated;

drop policy if exists ulbra_conversas_leitura on public.ulbra_conversas;
create policy ulbra_conversas_leitura on public.ulbra_conversas
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and usuario_e_gestao()
  );
drop policy if exists ulbra_atendimentos_leitura on public.ulbra_atendimentos;
create policy ulbra_atendimentos_leitura on public.ulbra_atendimentos
  for select to authenticated using (
    not eh_painel() and app_usuario_ativo() and usuario_e_gestao()
  );

do $$ begin
  perform public.afirmar(
    not has_function_privilege('authenticated', 'public.ulbra_atendimento_assumir(text)', 'execute'),
    'VOLTA AO PILOTO: assumir fechado de novo para authenticated');
end $$;

select 'REGIME POS-PILOTO: todas as afirmacoes passaram' as resultado;
