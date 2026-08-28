-- Casos marcados como quitacao total (status_financeiro QUITADO/QUITADO_CONFIRMACAO/
-- QUITADO_LINK_PAGAMENTO ou tabulacao de quitacao com quitado_em) que ainda tem saldo
-- real precisam SAIR da quitacao: o marcador mente sobre a divida e o caso some das filas.
--
-- Diferenca para corrigir_quitado_com_saldo (2026-08-24): aquela so cobre saldo vindo de
-- parcela de acordo ATIVO (17 de 79 casos). Esta cobre tambem o saldo vindo de titulo/
-- mensalidade e delega situacao/criticidade/proxima acao para recalcular_situacao_aluno.
--
-- NAO toca em acordos, parcelas, titulos nem pagamentos: so desfaz o marcador operacional.

create table if not exists public._backup_sair_quitacao_total (
  id uuid primary key default gen_random_uuid(),
  lote text not null,
  caso_id uuid,
  aluno_id uuid,
  caso_snapshot jsonb,
  aluno_snapshot jsonb,
  saldo numeric,
  executado_por text,
  criado_em timestamptz not null default now()
);
alter table public._backup_sair_quitacao_total enable row level security;
drop policy if exists "_backup_sair_quitacao_total deny all" on public._backup_sair_quitacao_total;
create policy "_backup_sair_quitacao_total deny all"
  on public._backup_sair_quitacao_total for all to authenticated, anon using (false) with check (false);

create index if not exists idx_backup_sair_quitacao_total_lote on public._backup_sair_quitacao_total(lote);

create or replace function public.sair_quitacao_total_com_saldo(
  p_limite integer default 5,
  p_dry_run boolean default true,
  p_lote text default null,
  p_executado_por text default 'sair_quitacao_total_com_saldo'
)
returns table(
  caso_codigo integer,
  aluno_id uuid,
  aluno_nome text,
  saldo numeric,
  origem_saldo text,
  status_anterior text,
  status_novo text,
  situacao_nova text,
  acao text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_lote text := coalesce(p_lote, to_char(now(),'YYYYMMDDHH24MISS'));
  v_n int := 0;
  v_bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  v_quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO'];
  v_saldo numeric; v_parc numeric; v_tit numeric;
  v_acion text; v_jorn text; v_atual text; v_origem text;
  v_st_ant text; v_sit_nova text;
  v_recalc jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if not (public.usuario_e_gestao() and public.perfil_do_usuario_atual() is not null) then
      raise exception 'Acesso negado: sair_quitacao_total_com_saldo exige gestao.' using errcode='42501';
    end if;
  end if;

  for r in
    select c.id, c.caso_codigo, c.aluno_id, c.cpf_limpo,
           c.status_atual, c.status_acionamento, c.status_jornada, c.status_financeiro,
           public.aluno_saldo_pendente_detalhe(c.aluno_id, null) sd
    from public.casos c
    where c.aluno_id is not null
      -- marcador de quitacao total, em qualquer um dos eixos
      and (upper(coalesce(c.status_financeiro,'')) in ('QUITADO','QUITADO_CONFIRMACAO','QUITADO_LINK_PAGAMENTO')
        or (public.normalizar_status_acionamento(c.status_atual) = any(array['PAGO','QUITADO','QUITADO MANUAL'])
            and c.quitado_em is not null))
      -- nunca reabrir caso bloqueado (cancelamento definitivo / juridico)
      and public.normalizar_status_acionamento(c.status_atual) <> all(v_bloq)
      and coalesce(public.normalizar_status_acionamento(c.status_acionamento),'') <> all(v_bloq)
      and coalesce(public.normalizar_status_acionamento(c.status_jornada),'') <> all(v_bloq)
      -- so quem tem saldo real (parcela em aberto de acordo vivo OU titulo em aberto)
      and (public.aluno_saldo_pendente_detalhe(c.aluno_id, null)->>'total')::numeric > 0.005
    order by (public.aluno_saldo_pendente_detalhe(c.aluno_id, null)->>'total')::numeric desc,
             c.caso_codigo
  loop
    exit when v_n >= coalesce(p_limite, 2147483647);

    v_saldo := round((r.sd->>'total')::numeric, 2);
    v_parc  := coalesce((r.sd->>'parcelas_abertas_valor')::numeric, 0);
    v_tit   := coalesce((r.sd->>'titulos_abertos')::numeric, 0);
    v_origem := case
      when v_parc > 0.005 and v_tit > 0.005 then 'PARCELA+TITULO'
      when v_parc > 0.005 then 'PARCELA'
      else 'TITULO'
    end;

    -- Marcador de quitacao vira null; tabulacao legitima do operador ("Mensagem
    -- enviada", "Em negociacao"...) e preservada. Sem tabulacao aproveitavel o caso
    -- volta como CONTATAR, que e o estado neutro de fila.
    v_atual := case when public.normalizar_status_acionamento(r.status_atual) = any(v_quit)
                      or coalesce(r.status_atual,'') = '' then 'CONTATAR' else r.status_atual end;
    v_acion := case when public.normalizar_status_acionamento(r.status_acionamento) = any(v_quit)
                    then null else r.status_acionamento end;
    v_jorn  := case when public.normalizar_status_acionamento(r.status_jornada) = any(v_quit)
                    then null else r.status_jornada end;

    caso_codigo := r.caso_codigo;
    aluno_id := r.aluno_id;
    aluno_nome := (select nome from public.alunos where id = r.aluno_id);
    saldo := v_saldo;
    origem_saldo := v_origem;
    v_st_ant := coalesce(r.status_atual,'(sem status)')||' / '||coalesce(r.status_financeiro,'(sem financeiro)');
    status_anterior := v_st_ant;
    status_novo := v_atual;

    if p_dry_run then
      situacao_nova := '(dry-run)';
      acao := 'DRY_RUN';
      return next; v_n := v_n + 1; continue;
    end if;

    insert into public._backup_sair_quitacao_total(lote, caso_id, aluno_id, caso_snapshot, aluno_snapshot, saldo, executado_por)
    select v_lote, r.id, r.aluno_id, to_jsonb(cc.*),
           (select to_jsonb(aa.*) from public.alunos aa where aa.id = r.aluno_id),
           v_saldo, p_executado_por
    from public.casos cc where cc.id = r.id;

    update public.casos
       set status_atual = v_atual,
           status_financeiro = 'EM_ABERTO',
           status_acionamento = v_acion,
           status_jornada = v_jorn,
           total_em_aberto = v_saldo,
           quitado_em = null,
           caso_atualizado_por = p_executado_por,
           caso_atualizado_em = now()
     where id = r.id;

    update public.alunos
       set status_atual = v_atual,
           status_jornada = case when public.normalizar_status_acionamento(status_jornada) = any(v_quit)
                                 then null else status_jornada end,
           status_acionamento = case when public.normalizar_status_acionamento(status_acionamento) = any(v_quit)
                                     then null else status_acionamento end,
           valor_em_aberto = v_saldo
     where id = r.aluno_id;

    -- o motor decide situacao, criticidade, proxima acao e data de retorno
    v_recalc := public.recalcular_situacao_aluno(r.aluno_id, 'sair_quitacao_total_'||v_lote);
    v_sit_nova := v_recalc->>'situacao';
    situacao_nova := v_sit_nova;

    insert into public.aluno_movimentacoes(aluno_id, tipo, descricao, status_anterior, status_novo,
                                           registrado_por_nome, registrado_por_email, registrado_em)
    values (r.aluno_id::text, 'SAIU_QUITACAO_TOTAL_COM_SALDO',
      'Caso estava marcado como quitacao total mas possui saldo real de '||public.fmt_brl(v_saldo)
      ||' ('||v_origem||'). Marcador desfeito e situacao recalculada. Acordos, parcelas, titulos e pagamentos intactos.',
      v_st_ant, coalesce(v_sit_nova, v_atual), 'Sistema', p_executado_por, now());

    if public.caso_encerrado_operacional(r.cpf_limpo, v_atual, v_acion, 'EM_ABERTO', v_jorn) then
      raise exception 'Caso % continua encerrado apos sair da quitacao', r.caso_codigo;
    end if;

    acao := 'REABERTO';
    return next; v_n := v_n + 1;
  end loop;
end;
$function$;

revoke all on function public.sair_quitacao_total_com_saldo(integer, boolean, text, text) from public, anon;
grant execute on function public.sair_quitacao_total_com_saldo(integer, boolean, text, text) to authenticated, service_role;
