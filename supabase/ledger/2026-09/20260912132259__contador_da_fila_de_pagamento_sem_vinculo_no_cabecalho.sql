-- A gestao foi explicita: "nao quero uma fila que exista apenas como tabela no
-- banco e fique acumulando pagamentos sem tratamento". Item de menu resolve o
-- acesso; nao resolve a DESCOBERTA -- alguem ainda precisa abrir a tela para
-- saber que tem pendencia. Medido: 30 a 40% das linhas de certos lotes caem na
-- fila, logo isso e trabalho diario, nao excecao rara.
--
-- Entao a fila entra no contador do cabecalho, como as outras filas do sistema
-- (links, baixas, elogios, termos).
--
-- POR QUE uma funcao separada em vez de um subselect dentro de
-- contadores_cabecalho: aquela funcao NAO e security definer -- roda com o
-- privilegio de quem chama e depende de RLS. Um count direto em `pagamentos`
-- ali devolveria 0 silenciosamente. Esta aqui e definer e carrega o proprio
-- portao: quem nao e gestao recebe 0, nao erro e nao numero.

create or replace function public.pagamentos_sem_vinculo_contar()
 returns integer
 language sql
 security definer
 stable
 set search_path to 'public'
as $fn$
  select case
    when coalesce(public.usuario_e_gestao(), false)
      then (select count(*)::int from public.pagamentos where aluno_id is null)
    else 0
  end;
$fn$;

comment on function public.pagamentos_sem_vinculo_contar() is
  'Pendencia da fila de pagamentos sem vinculo, para o badge do menu. Devolve 0 para quem nao e gestao -- nunca erro, para nao derrubar o cabecalho de ninguem.';

grant execute on function public.pagamentos_sem_vinculo_contar() to authenticated;
revoke all on function public.pagamentos_sem_vinculo_contar() from public, anon;

-- contadores_cabecalho ganha a chave nova. Corpo restante byte a byte igual ao
-- que estava em producao -- so a linha nova entrou.
create or replace function public.contadores_cabecalho()
 returns jsonb
 language sql
 set search_path to 'public'
as $fn$
  select jsonb_build_object(
    'links_aguardando', (
      select count(*) from public.links_pagamento
      where status in ('SOLICITADO_LINK','LINK_EM_ATENDIMENTO')),
    'baixas_aguardando', (
      select count(*) from public.links_pagamento
      where status = 'AGUARDANDO_BAIXA'),
    'termos_aguardando_adm', (
      select count(*) from public.termos_acordo
      where status = 'TERMO_ENVIADO_ADM'
         or (status = 'TERMO_LIBERADO_AUTOMATICO_GOV'
             and validado_por = 'AUTOMATICO_GOV_BR')),
    'elogios_pendentes', (
      select count(*) from public.elogios_atendimento
      where status = 'PENDENTE_ANALISE'),
    'termos_rejeitados', (
      select count(*) from (
        select distinct on (t.aluno_id) t.status
        from public.termos_acordo t
        where lower(t.operador_email) = lower(coalesce(auth.email(), ''))
        order by t.aluno_id, t.criado_em desc
      ) u where u.status = 'TERMO_REJEITADO'),
    'pagamentos_sem_vinculo', public.pagamentos_sem_vinculo_contar(),
    'parcelas_vencendo', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from public.parcelas_vencendo_2_dias() x)
  );
$fn$;

do $$
declare v_tem boolean;
begin
  select prosrc like '%pagamentos_sem_vinculo%' into v_tem
    from pg_proc where proname='contadores_cabecalho';
  if not coalesce(v_tem,false) then
    raise exception 'contadores_cabecalho nao recebeu a chave pagamentos_sem_vinculo';
  end if;
  if not has_function_privilege('authenticated',
        (select oid from pg_proc where proname='pagamentos_sem_vinculo_contar'), 'EXECUTE') then
    raise exception 'contador da fila sem EXECUTE para authenticated -- o badge nao apareceria';
  end if;
  raise notice 'badge da fila: contador criado com portao proprio e ligado ao cabecalho';
end $$;
