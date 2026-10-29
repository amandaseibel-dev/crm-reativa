-- ============================================================================
-- CALIBRAGEM — PAINEL DE EFETIVIDADE + INDIVIDUAL (itens 6/7)
-- ----------------------------------------------------------------------------
-- calibragem_efetividade(de, ate, operador?) — mede a EXECUÇÃO do operador no
-- período, separando tamanho/dificuldade da carteira do trabalho humano.
-- Só considera movimentações HUMANAS válidas (exclui automações do sistema).
--
-- Permissão: gestão vê toda a equipe; operador vê apenas o próprio (o
-- p_operador é forçado ao e-mail do JWT quando não é gestão) — item 7.
-- On-demand; índice em aluno_movimentacoes.registrado_em para o período.
-- Reversível.
-- ============================================================================

begin;

create index if not exists idx_aluno_mov_registrado_em on public.aluno_movimentacoes(registrado_em);
create index if not exists idx_aluno_mov_reg_por on public.aluno_movimentacoes(registrado_por_email, registrado_em);

create or replace function public.calibragem_efetividade(
  p_de date, p_ate date, p_operador text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ini timestamptz := p_de::timestamptz;
  v_fim timestamptz := (p_ate + 1)::timestamptz;
  v_op text := p_operador;
  v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_res jsonb;
begin
  -- operador só vê a si mesmo; gestão vê todos (ou filtra por p_operador)
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    v_op := v_email;
  end if;

  with carteira as (
    select operador_email op_email, max(operador_nome) op_nome, count(*) cpfs
    from public.casos where operador_email is not null
      and (v_op is null or operador_email = v_op)
    group by operador_email
  ),
  mov as (
    select registrado_por_email op_email,
      count(*) filter (where tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')) acionamentos,
      count(distinct aluno_id) filter (where tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')) trabalhados_total,
      count(*) filter (where tipo='CONTATO') contatos,
      count(*) filter (where tipo='LINK_ENVIADO_AO_ALUNO') links_env,
      count(*) filter (where tipo='TERMO_ENVIADO_ADM') termos_env
    from public.aluno_movimentacoes
    where registrado_em >= v_ini and registrado_em < v_fim
      and registrado_por_email is not null
    group by registrado_por_email
  ),
  -- trabalhados DENTRO da carteira atual (item 6.1: cobertura)
  trab_cart as (
    select c.operador_email op_email, count(distinct m.aluno_id) trabalhados
    from public.casos c
    join public.aluno_movimentacoes m
      on m.aluno_id = c.aluno_id::text and m.registrado_por_email = c.operador_email
     and m.registrado_em >= v_ini and m.registrado_em < v_fim
     and m.tipo in ('CONTATO','ASSUMIU_ATENDIMENTO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','OBSERVACAO','FINALIZACAO_ATENDIMENTO','COMPROVANTE_ENVIADO_BAIXA','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')
    where c.operador_email is not null
    group by c.operador_email
  ),
  -- recuperado real: parcelas pagas no período (por operador do acordo)
  pg as (
    select a.operador_responsavel_email op_email,
           count(*) pagamentos, coalesce(sum(p.valor),0) recuperado,
           count(distinct a.aluno_id) cpfs_pagos
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
    where upper(coalesce(p.status,'')) in ('PAGO','PAGA')
      and coalesce(p.pago_em, p.atualizado_em) >= v_ini and coalesce(p.pago_em, p.atualizado_em) < v_fim
    group by a.operador_responsavel_email
  ),
  ac as (
    select operador_responsavel_email op_email, count(*) acordos, count(distinct aluno_id) cpfs_acordo
    from public.acordos
    where criado_em >= v_ini and criado_em < v_fim and lower(coalesce(status,'')) not in ('cancelado','cancelada')
    group by operador_responsavel_email
  ),
  tass as (
    select operador_email op_email, count(*) termos_assinados
    from public.termos_acordo
    where validado_em >= v_ini and validado_em < v_fim
      and lower(coalesce(status,'')) in ('validado','aprovado','assinado','liberado')
    group by operador_email
  ),
  aguard as (
    select operador_email op_email, count(*) aguardando
    from public.solicitacoes_confirmacao_pagamento
    where upper(coalesce(status,'')) = 'AGUARDANDO_CONFIRMACAO'
    group by operador_email
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operador_email', c.op_email, 'operador_nome', c.op_nome,
    'carteira_cpfs', c.cpfs,
    'trabalhados', coalesce(tc.trabalhados,0),
    'trabalhados_total', coalesce(m.trabalhados_total,0),
    'cobertura_pct', least(100, round(100.0*coalesce(tc.trabalhados,0)/nullif(c.cpfs,0),1)),
    'acionamentos', coalesce(m.acionamentos,0),
    'contatos', coalesce(m.contatos,0),
    'acordos', coalesce(a.acordos,0),
    'pagamentos_confirmados', coalesce(pg.pagamentos,0),
    'recuperado', round(coalesce(pg.recuperado,0),2),
    'conv_acordo_pct', round(100.0*coalesce(a.cpfs_acordo,0)/nullif(tc.trabalhados,0),1),
    'conv_pagamento_pct', round(100.0*coalesce(pg.cpfs_pagos,0)/nullif(tc.trabalhados,0),1),
    'links_enviados', coalesce(m.links_env,0),
    'termos_enviados', coalesce(m.termos_env,0),
    'termos_assinados', coalesce(t.termos_assinados,0),
    'aguardando_confirmacao', coalesce(g.aguardando,0)
  ) order by c.op_nome), '[]'::jsonb)
  into v_res
  from carteira c
  left join mov m on m.op_email = c.op_email
  left join trab_cart tc on tc.op_email = c.op_email
  left join ac a on a.op_email = c.op_email
  left join pg on pg.op_email = c.op_email
  left join tass t on t.op_email = c.op_email
  left join aguard g on g.op_email = c.op_email;

  return jsonb_build_object('de', p_de, 'ate', p_ate, 'operadores', v_res);
end; $$;
revoke all on function public.calibragem_efetividade(date,date,text) from public;
grant execute on function public.calibragem_efetividade(date,date,text) to authenticated;

commit;
