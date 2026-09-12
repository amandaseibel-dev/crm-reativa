-- CORRECAO DE UM ERRO MEU, NA MIGRATION ANTERIOR DESTA MESMA SESSAO.
--
-- Eu revoguei EXECUTE de `authenticated` em pagamentos_sem_aluno(text) para
-- "restringir a leitura a gestao". Isso esta ERRADO no Supabase: todo usuario
-- logado chama a API justamente COMO `authenticated`. A revogacao nao restringe
-- a gestao -- ela derruba a tela para todo mundo, Amanda e Fernanda incluidas.
--
-- O padrao certo (o mesmo de pagamento_vincular_aluno) e: EXECUTE para
-- `authenticated` + portao interno por usuario_e_gestao(). Quem nao e gestao
-- recebe 42501 do banco, e nao um menu quebrado.
--
-- Na mesma migration entrego o backend da fila operacional:
--   * portao de gestao dentro da funcao;
--   * motivo FINANCEIRO vindo de fila_pagamento_sem_vinculo (o motivo antigo,
--     por nome, continua -- os dois respondem perguntas diferentes);
--   * candidatos como SUGESTAO explicita, nunca como vinculo;
--   * opcao de ver todos os meses, porque os 55 pagamentos sem aluno que
--     existem hoje sao todos de 2026-07 e ficavam invisiveis no mes corrente.

drop function if exists public.pagamentos_sem_aluno(text);

create or replace function public.pagamentos_sem_aluno(
  p_mes text default null,
  p_todos_os_meses boolean default false
)
returns table (
  pagamento_id uuid,
  data_pagamento date,
  aluno_nome text,
  matricula text,
  titulo_numero text,
  numero_parcela_completo text,
  valor_pago numeric,
  valor_honorario numeric,
  operador_nome text,
  operador_email text,
  motivo text,
  candidatos integer,
  -- NOVO, vindo da fila de identificador financeiro
  motivo_financeiro text,
  sugestoes jsonb,
  detectado_em timestamptz,
  importacao_id uuid,
  arquivo_nome text
)
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- Portao de gestao. Ler quem pagou, quanto e por qual operador nao e dado de
  -- operador. Mesma regra de quem pode GRAVAR o vinculo.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  return query
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select
    p.id, p.data_pagamento, p.aluno_nome, p.matricula,
    p.titulo_numero, p.numero_parcela_completo,
    p.valor_pago, p.valor_honorario,
    p.operador_nome, p.operador_email,
    -- motivo HISTORICO, por nome: serve para a pessoa saber se ha homonimo.
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- motivo FINANCEIRO: por que nenhum identificador resolveu. Quando a linha
    -- entrou antes da regra nova, nao existe fila -- e isso fica dito.
    coalesce(f.motivo, 'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    -- SUGESTOES. Nunca aplicadas. A tela mostra como sugestao e a pessoa decide.
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome
  from public.pagamentos p
  cross join mes
  left join lateral (
    select count(*)::int as qtd from public.alunos a
     where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
       and coalesce(trim(p.aluno_nome),'') <> ''
  ) c on true
  left join public.fila_pagamento_sem_vinculo f
    on f.pagamento_id = p.id and f.decisao is null
  left join public.importacoes i on i.id = p.importacao_id
  where p.aluno_id is null
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$fn$;

-- EXECUTE volta para authenticated: o portao agora esta DENTRO da funcao.
grant execute on function public.pagamentos_sem_aluno(text, boolean) to authenticated;
revoke all on function public.pagamentos_sem_aluno(text, boolean) from public, anon;

-- PROVA
do $$
declare v_auth boolean; v_anon boolean; v_tem_portao boolean;
begin
  select has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE'),
         p.prosrc like '%usuario_e_gestao%'
    into v_auth, v_anon, v_tem_portao
    from pg_proc p where p.proname = 'pagamentos_sem_aluno';

  if not v_auth then
    raise exception 'pagamentos_sem_aluno continua sem EXECUTE para authenticated -- a tela quebraria';
  end if;
  if v_anon then
    raise exception 'pagamentos_sem_aluno ficou aberta para anon';
  end if;
  if not v_tem_portao then
    raise exception 'pagamentos_sem_aluno sem portao interno de gestao';
  end if;
  -- a assinatura antiga de 1 argumento nao pode sobrar: o PostgREST resolveria
  -- para ela e o portao seria contornado.
  if (select count(*) from pg_proc where proname = 'pagamentos_sem_aluno') <> 1 then
    raise exception 'existe mais de uma assinatura de pagamentos_sem_aluno';
  end if;
  raise notice 'fila: RPC com portao de gestao, EXECUTE para authenticated, anon fora';
end $$;
