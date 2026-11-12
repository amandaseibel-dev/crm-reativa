-- =============================================================================
-- ULBRA — Central: conversas da equipe Reativa por período (enviadas e recebidas).
-- PENDENTE. NÃO APLICAR sem autorização expressa da gestão.
--
-- O QUE INSTALA: 1 função public.ulbra_central_conversas(
--     p_desde timestamptz default null,  -- início do período; null = 1º dia do mês corrente (Brasília)
--     p_operador text default null,      -- só a gestão escolhe; operador é sempre o próprio e-mail
--     p_limite integer default 100, p_pagina integer default 0) -> jsonb
--
-- O QUE DEVOLVE (só leitura; nunca chama a ULBRA): conversas da equipe Reativa
-- com última mensagem no período, da MAIS RECENTE para a mais antiga, cada uma
-- com a direção da última mensagem (`recebida` = do aluno, `enviada` = da
-- equipe) e se está aguardando resposta. Só linhas com vínculo ATIVO alta_cpf
-- (CPF confirmado): o que não tem CPF confirmado NÃO sai daqui para ninguém —
-- vai como CONTAGEM (`totais.sem_cpf`) só para a gestão, e fica na conferência
-- do painel CRM ULBRA.
--
-- RECORTE (igual ao de ulbra_central_operador): gestão vê tudo ou o operador
-- pedido; qualquer outro usuário ativo vê só os alunos de que tem caso ou que
-- assumiu; painel de TV e inativo: ACESSO_NEGADO.
-- Ver não é responder: `responsabilidade` e `minha` vêm da mesma régua.
-- Paginação sem perda: ordem total (mensagem_em desc, id) e `totais` em toda página.
-- =============================================================================
create or replace function public.ulbra_central_conversas(
  p_desde timestamptz default null,
  p_operador text default null,
  p_limite integer default 100,
  p_pagina integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := lower(coalesce(app_email(), ''));
  v_gestao   boolean;
  v_op       text;
  v_desde    timestamptz;
  c_teto     constant int := 200;
  v_lim      int := least(greatest(coalesce(p_limite, 100), 1), c_teto);
  v_off      int;
  v_total    int;
  v_aguard   int;
  v_sem_cpf  int := null;
  v_linhas   jsonb;
begin
  if v_email = '' or not app_usuario_ativo() or eh_painel() then
    return jsonb_build_object('ok', false, 'motivo', 'ACESSO_NEGADO');
  end if;
  v_off := greatest(coalesce(p_pagina, 0), 0) * v_lim;
  v_gestao := usuario_e_gestao();
  v_op := case when v_gestao then nullif(lower(btrim(coalesce(p_operador, ''))), '') else v_email end;
  -- Período: padrão é o mês corrente em Brasília. Nunca abaixo de 120 dias atrás.
  v_desde := coalesce(p_desde, (date_trunc('month', now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo');
  if v_desde < now() - interval '120 days' then v_desde := now() - interval '120 days'; end if;

  with dono as (
    select distinct k.aluno_id, lower(k.operador_email) as operador
      from public.casos k
     where k.aluno_id is not null and k.operador_email is not null
       and exists (select 1 from public.ulbra_vinculos vv where vv.aluno_id = k.aluno_id and vv.desvinculado_em is null and vv.confianca = 'alta_cpf')
  ), cart as (
    select d.aluno_id, count(*) as qtd, case when count(*) = 1 then min(d.operador) end as unico
      from dono d group by d.aluno_id
  ), assum as (
    select t.aluno_id, min(lower(t.responsavel_email)) as por
      from public.ulbra_atendimentos t
     where t.responsavel_email is not null and t.dispensado_em is null
       and t.aluno_status = 'vinculado' and t.aluno_id is not null
       and exists (select 1 from public.ulbra_vinculos vv where vv.aluno_id = t.aluno_id and vv.desvinculado_em is null and vv.confianca = 'alta_cpf')
     group by t.aluno_id having count(distinct lower(t.responsavel_email)) = 1
  ), resp as (
    select x.aluno_id, coalesce(c.qtd, 0) as qtd,
           case when coalesce(c.qtd, 0) = 1 then c.unico when s.por is not null then s.por end as responsavel,
           case when coalesce(c.qtd, 0) = 1 then 'CARTEIRA' when s.por is not null then 'ASSUMIDO'
                when coalesce(c.qtd, 0) > 1 then 'A_DEFINIR' else 'SEM_CARTEIRA' end as responsabilidade
      from (select aluno_id from cart union select aluno_id from assum) x
      left join cart c on c.aluno_id = x.aluno_id
      left join assum s on s.aluno_id = x.aluno_id
  ), base as (
    select c.ulbra_conversa_id, c.aluno_id, c.cliente_nome, c.ultima_mensagem_previa, c.ultima_mensagem_em,
           c.ultima_mensagem_quem, c.ultima_mensagem_cliente_em, c.responsavel_ulbra, c.situacao,
           r.responsavel, r.responsabilidade, r.qtd,
           exists (select 1 from public.ulbra_leitura_usuario l
                    where l.ulbra_conversa_id = c.ulbra_conversa_id and l.usuario_email = v_email
                      and l.lido_ate >= coalesce(c.ultima_mensagem_cliente_em, c.ultima_mensagem_em)) as lida
      from public.ulbra_conversas c
      left join resp r on r.aluno_id = c.aluno_id
     where c.equipe = 'Reativa'
       and c.ultima_mensagem_em >= v_desde
       and c.aluno_status = 'vinculado' and c.aluno_id is not null
       and exists (select 1 from public.ulbra_vinculos vv where vv.ulbra_cliente_id = c.ulbra_cliente_id and vv.desvinculado_em is null and vv.confianca = 'alta_cpf')
       and (v_op is null
            or exists (select 1 from dono d where d.aluno_id = c.aluno_id and d.operador = v_op)
            or r.responsavel = v_op)
  ), ordenada as (
    select * from base order by ultima_mensagem_em desc, ulbra_conversa_id limit v_lim offset v_off
  )
  select (select count(*) from base),
         (select count(*) from base where ultima_mensagem_quem = 'cliente'),
         coalesce(jsonb_agg(jsonb_build_object(
           'conversa_id', o.ulbra_conversa_id,
           'aluno_id', o.aluno_id,
           'nome', o.cliente_nome,
           'previa', o.ultima_mensagem_previa,
           'mensagem_em', o.ultima_mensagem_em,
           'quem', o.ultima_mensagem_quem,
           'direcao', case when o.ultima_mensagem_quem = 'cliente' then 'recebida' else 'enviada' end,
           'aguardando', (o.ultima_mensagem_quem = 'cliente'),
           'situacao', o.situacao,
           'atendente_ulbra', o.responsavel_ulbra,
           'responsabilidade', coalesce(o.responsabilidade, 'SEM_CARTEIRA'),
           'responsavel_reativa', case when v_gestao or o.responsavel = v_op then o.responsavel end,
           'responsavel_e_outro', (o.responsavel is not null and v_op is not null and o.responsavel <> v_op),
           'responsavel_definido', (o.responsavel is not null),
           'minha', (v_op is not null and o.responsavel is not distinct from v_op and o.responsavel is not null),
           'divergencia', (coalesce(o.qtd, 0) > 1),
           'lida', o.lida
         ) order by o.ultima_mensagem_em desc, o.ulbra_conversa_id), '[]'::jsonb)
    into v_total, v_aguard, v_linhas
    from ordenada o;

  -- Só contagem, só para a gestão: o que há no período sem CPF confirmado.
  if v_gestao then
    select count(*) into v_sem_cpf from public.ulbra_conversas c
     where c.equipe = 'Reativa' and c.ultima_mensagem_em >= v_desde
       and not (c.aluno_status = 'vinculado' and c.aluno_id is not null
                and exists (select 1 from public.ulbra_vinculos vv where vv.ulbra_cliente_id = c.ulbra_cliente_id and vv.desvinculado_em is null and vv.confianca = 'alta_cpf'));
  end if;

  return jsonb_build_object(
    'ok', true, 'gerado_em', now(), 'eh_gestao', v_gestao, 'operador', v_op, 'desde', v_desde,
    'limite', v_lim, 'pagina', greatest(coalesce(p_pagina, 0), 0),
    'totais', jsonb_build_object('conversas', v_total, 'aguardando', v_aguard, 'sem_cpf', v_sem_cpf),
    'conversas', v_linhas
  );
end;
$$;

comment on function public.ulbra_central_conversas(timestamptz, text, integer, integer) is
  'Conversas da equipe Reativa no período (padrão: mês corrente), mais recente primeiro, com direção da última mensagem. Só CPF confirmado (vínculo ativo alta_cpf); sem CPF vai só como contagem para a gestão. Recorte no banco: gestão tudo ou o operador pedido; os demais só o próprio e-mail. Só lê o Postgres.';

revoke all on function public.ulbra_central_conversas(timestamptz, text, integer, integer) from public, anon;
grant execute on function public.ulbra_central_conversas(timestamptz, text, integer, integer) to authenticated;
