-- ============================================================================
-- CALIBRAGEM — ATENDIMENTO SEM TABULAÇÃO (item 4)
-- ----------------------------------------------------------------------------
-- Não pode existir vantagem operacional pela ausência de tabulação. O registro
-- de "assumiu atendimento" já é feito (aluno_movimentacoes ASSUMIU_ATENDIMENTO /
-- EM_ATENDIMENTO, historico_operadores_alunos). Aqui damos VISIBILIDADE às
-- pendências: atendimentos assumidos que NÃO tiveram tabulação posterior
-- (contato/acordo/link/termo/finalização) dentro da janela.
--
-- Operador vê o próprio; gestão vê todos. Somente leitura. Reversível.
-- ============================================================================

begin;

create or replace function public.calibragem_atendimentos_sem_tabulacao(p_horas int default 24)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_op_gestao boolean := (public.calibragem_e_gestao() or auth.jwt() is null);
  v_email text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_corte timestamptz := now() - make_interval(hours => p_horas);
  v_res jsonb; v_por_op jsonb;
begin
  with assumidos as (
    select a.id, a.aluno_id, a.registrado_por_email op_email, a.registrado_por_nome op_nome,
           a.registrado_em, a.descricao
    from public.aluno_movimentacoes a
    where a.tipo in ('ASSUMIU_ATENDIMENTO','EM_ATENDIMENTO')
      and a.registrado_em < v_corte
      and a.registrado_por_email is not null
      and (v_op_gestao or a.registrado_por_email = v_email)
  ),
  -- tabulação posterior pelo mesmo operador no mesmo aluno
  pendentes as (
    select s.* from assumidos s
    where not exists (
      select 1 from public.aluno_movimentacoes t
      where t.aluno_id = s.aluno_id
        and t.registrado_por_email = s.op_email
        and t.registrado_em > s.registrado_em
        and t.tipo in ('CONTATO','OBSERVACAO','ACORDO','LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','TERMO_ENVIADO_ADM','QUITADO_MANUAL','QUITACAO_CONFIRMADA','FINALIZACAO_ATENDIMENTO','FINALIZACAO','PAGAMENTO_REJEITADO','RETORNO_ADM_CRIADO')
    )
  ),
  -- pega a assunção mais recente sem tabulação por (operador, aluno)
  dedup as (
    select distinct on (op_email, aluno_id) op_email, op_nome, aluno_id, registrado_em
    from pendentes order by op_email, aluno_id, registrado_em desc
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'op_email', op_email, 'op_nome', op_nome, 'qtd', qtd, 'mais_antigo', mais_antigo) order by qtd desc), '[]'::jsonb)
  into v_por_op
  from (
    select op_email, max(op_nome) op_nome, count(*) qtd, min(registrado_em) mais_antigo
    from dedup group by op_email
  ) g;

  return jsonb_build_object('janela_horas', p_horas, 'por_operador', v_por_op);
end; $$;
revoke all on function public.calibragem_atendimentos_sem_tabulacao(int) from public;
grant execute on function public.calibragem_atendimentos_sem_tabulacao(int) to authenticated;

commit;
