-- ENCERRAMENTO ADMINISTRATIVO DA CONFERENCIA PRIME (19/09/2026)
--
-- Saida definitiva para titulo EM_CONFIRMACAO cuja classe humana e
-- CANCELAMENTO_ESTORNO ou ISENCAO_FIES_BOLSA: a divida deixou de ser exigivel
-- por motivo administrativo/academico. NAO e pagamento, NAO e acordo, NAO e
-- recuperacao da ReATIVA.
--
--   titulo    -> situacao CANCELADA / status cancelada (estado terminal
--                administrativo ja usado pelo CRM: "saiu da base"), com
--                proveniencia propria: origem_encerramento /_ref /_em.
--                origem_liquidacao (dinheiro) NAO e tocada.
--   decisao   -> ENCERRADO_ADMINISTRATIVO (nova decisao terminal; CONFIRMADO
--                significa PAGO e REJEITADO devolve a cobranca).
--   aluno     -> recalculo normal: com outra divida exigivel segue em
--                COBRANCA_VENCIDA/ACORDO_EM_DIA (caso ativo, responsavel);
--                sem divida e sem outro EM_CONFIRMACAO vira SEM_PENDENCIA e o
--                caso encerra NA MESMA OPERACAO como SEM_SALDO_EM_ABERTO
--                (status final sem pagamento, de 24/07), nunca QUITADO;
--                com outro EM_CONFIRMACAO fica AGUARDANDO_CONFIRMACAO.
--   quitacao  -> _trg_auto_quitar_titulo ignora a saida para CANCELADA:
--                nada de QUITADO_AUTOMATICO, quitado_em ou reposicao.
--   metricas  -> carteira_2026_1_classificar: CANCELADA = FORA_DA_BASE
--                (nunca INADIMPLENCIA). O saldo historico so conta ABERTO
--                como aberto (CANCELADA ja fica fora; testado).
--   terminal  -> titulo com origem_encerramento nao volta a ABERTO/NEGOCIADO
--                por nenhuma rotina (gatilho protetor + as protecoes que ja
--                existem: titulo_reavaliar, vinculo, motor do a vista).
--
-- Zero efeito financeiro: nenhum pagamento, acordo, parcela, vinculo, baixa,
-- honorario, comissao ou recuperacao.

begin;

-- ===== 0. FOTO (a prova do fim confere que nada de dado mudou) ===============
create temp table _ea_antes on commit drop as
select (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
       (select count(*) from public.acordos_titulos where situacao='EM_CONFIRMACAO') em_conf,
       (select count(*) from public.acordos_titulos where situacao='CANCELADA') canceladas,
       (select count(*) from public.acordos_titulos where situacao='PAGO') pagos,
       (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
       (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc;

-- ===== 1. ESTRUTURA =========================================================
-- Proveniencia administrativa, separada da proveniencia de dinheiro.
alter table public.acordos_titulos
  add column if not exists origem_encerramento text,
  add column if not exists origem_encerramento_ref text,
  add column if not exists origem_encerramento_em timestamptz;
alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null or origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA');

alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO','ENCERRADO_ADMINISTRATIVO']));

-- ===== 2. QUITACAO AUTOMATICA NAO VE CANCELAMENTO ===========================
create or replace function public._trg_auto_quitar_titulo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- EM_CONFIRMACAO conta como divida ainda nao resolvida: entrar nele nao
  -- quita ninguem; sair dele para PAGO (baixa confirmada) segue quitando.
  -- CANCELADA e saida ADMINISTRATIVA (saiu da base / encerramento pela
  -- Conferencia Prime): nao e quitacao, nao chama _talvez_quitar_aluno.
  if upper(coalesce(new.situacao,'')) = 'CANCELADA' then
    return new;
  end if;
  if upper(coalesce(old.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and upper(coalesce(new.situacao,'')) not in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO') then
    perform public._talvez_quitar_aluno(new.aluno_id);
  end if;
  return new;
end;
$function$;

-- ===== 3. TERMINAL: encerrado administrativamente nao ressuscita ============
create or replace function public._titulo_encerrado_administrativo_protegido()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
begin
  if v_oficial or old.origem_encerramento is null then
    return new;
  end if;
  if upper(coalesce(new.situacao,'')) <> 'CANCELADA'
     or lower(coalesce(new.status,'')) <> 'cancelada'
     or new.origem_encerramento is distinct from old.origem_encerramento
     or new.origem_encerramento_ref is distinct from old.origem_encerramento_ref
     or new.origem_encerramento_em is distinct from old.origem_encerramento_em then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento, 'tentou_situacao', new.situacao, 'tentou_status', new.status));
    new.situacao := 'CANCELADA';
    new.status := 'cancelada';
    new.origem_encerramento := old.origem_encerramento;
    new.origem_encerramento_ref := old.origem_encerramento_ref;
    new.origem_encerramento_em := old.origem_encerramento_em;
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_titulo_encerrado_administrativo_protegido on public.acordos_titulos;
create trigger trg_titulo_encerrado_administrativo_protegido
  before update on public.acordos_titulos
  for each row execute function public._titulo_encerrado_administrativo_protegido();

-- ===== 4. HELPER INTERNO: encerrar o caso zerado DESTE aluno ================
-- Mesma regra de casos_encerrar_zerados_sem_debito (SEM_SALDO_EM_ABERTO,
-- encerrado_operacional, ZERADO_REAL_SEM_SALDO, responsavel preservado), mas
-- para um aluno so, na mesma transacao. Nao e exposto a authenticated.
create or replace function public.prime_conferencia_encerrar_zerado_aluno(p_aluno_id uuid, p_quem text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_det jsonb; v_parc int; v_bloq boolean; v_casos int := 0; v_st_ant text; v_al record;
begin
  select * into v_al from public.alunos where id = p_aluno_id;
  if not found then return jsonb_build_object('encerrado', false, 'porque', 'ALUNO_NAO_ENCONTRADO'); end if;

  v_det := public.aluno_saldo_pendente_detalhe(p_aluno_id);
  if coalesce((v_det->>'total')::numeric, 1) > 0.005 then
    return jsonb_build_object('encerrado', false, 'porque', 'TEM_DIVIDA_EXIGIVEL', 'total', v_det->>'total');
  end if;
  if coalesce((v_det->>'titulos_em_confirmacao')::int, 0) > 0
     or exists (select 1 from public.acordos_titulos t where t.aluno_id = p_aluno_id and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO') then
    return jsonb_build_object('encerrado', false, 'porque', 'OUTRO_TITULO_EM_CONFIRMACAO');
  end if;
  if exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = p_aluno_id::text
              and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')) then
    return jsonb_build_object('encerrado', false, 'porque', 'CONFIRMACAO_PENDENTE');
  end if;
  select count(*) into v_parc from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');
  if v_parc > 0 then
    return jsonb_build_object('encerrado', false, 'porque', 'PARCELA_ABERTA', 'parcelas', v_parc);
  end if;
  v_bloq := ((upper(coalesce(v_al.status_atual,''))||' '||upper(coalesce(v_al.status_jornada,''))) ~ 'JURIDIC|CANCELAMENTO COBRANCA|SUSPENS');
  if v_bloq then
    return jsonb_build_object('encerrado', false, 'porque', 'ALUNO_TRAVADO', 'status', v_al.status_jornada);
  end if;

  update public.casos c
     set status_acionamento = case
           when public.normalizar_status_acionamento(c.status_acionamento) in
                ('PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
             then c.status_acionamento else 'SEM_SALDO_EM_ABERTO' end,
         status_financeiro = case
           when c.status_financeiro is null or upper(c.status_financeiro) = 'EM_ABERTO' then 'SEM_SALDO_EM_ABERTO'
           else c.status_financeiro end,
         encerrado_operacional = true,
         total_em_aberto = 0,
         caso_atualizado_por = p_quem,
         caso_atualizado_em = now()
   where c.aluno_id = p_aluno_id and not coalesce(c.encerrado_operacional, false);
  get diagnostics v_casos = row_count;

  v_st_ant := coalesce(v_al.status_jornada, '(sem)');
  update public.alunos a
     set status_atual = 'SEM_SALDO_EM_ABERTO', status_jornada = 'SEM_SALDO_EM_ABERTO', status_acionamento = 'SEM_SALDO_EM_ABERTO',
         valor_em_aberto = 0, proxima_acao = null, data_retorno = null, hora_retorno = null,
         registrado_por_email = p_quem, registrado_em = now()
   where a.id = p_aluno_id
     and public.normalizar_status_acionamento(coalesce(a.status_jornada,'')) not in
         ('PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO');

  -- O recalculo padrao rotula "sem saldo" como QUITADO. Aqui nao houve
  -- quitacao: a situacao operacional fica SEM_PENDENCIA, no aluno e no caso.
  update public.alunos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao = null, data_retorno = null
   where id = p_aluno_id and coalesce(situacao_operacional,'') in ('QUITADO','QUITADO_AGUARDANDO_BAIXA','SEM_PENDENCIA','');
  update public.casos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao_automatica = null, data_retorno = null
   where aluno_id = p_aluno_id and coalesce(situacao_operacional,'') in ('QUITADO','QUITADO_AGUARDANDO_BAIXA','SEM_PENDENCIA','');

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'ZERADO_REAL_SEM_SALDO',
          'Sem baixa/quitacao. Encerramento administrativo da divida (Conferencia Prime): sem saldo exigivel, caso encerrado como SEM_SALDO_EM_ABERTO. Matricula '
            || coalesce(v_al.matricula,'-') || '. Responsavel preservado.',
          v_st_ant, 'SEM_SALDO_EM_ABERTO', 'Sistema', p_quem, now());

  insert into public.historico_operadores_alunos
    (aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
  select c.aluno_id, c.chave_unificacao, c.nome, c.cpf, 'ZERADO_REAL_SEM_SALDO', c.operador_nome, c.operador_email,
         'Encerrado administrativamente pela Conferencia Prime, sem baixa/quitacao. Responsavel preservado.', now()
    from public.casos c where c.aluno_id = p_aluno_id and c.operador_email is not null limit 1;

  return jsonb_build_object('encerrado', true, 'casos', v_casos, 'status_aluno', 'SEM_SALDO_EM_ABERTO', 'situacao_operacional', 'SEM_PENDENCIA');
end;
$function$;
revoke all on function public.prime_conferencia_encerrar_zerado_aluno(uuid, text) from public, anon, authenticated;

-- ===== 5. A RPC OFICIAL =====================================================
create or replace function public.prime_conferencia_encerrar_administrativo(p_titulo_id uuid, p_observacao text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec public.prime_conferencia_decisao%rowtype;
  v_valor numeric; v_rec jsonb; v_zer jsonb; v_ev jsonb; v_liq text;
  v_pag0 int; v_ac0 int; v_parc0 int; v_vinc0 int;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Encerramento administrativo e decisao da gestao.' using errcode = '42501';
  end if;
  if length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: escreva a observacao do encerramento (minimo 10 caracteres).';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then raise exception 'TITULO_NAO_ENCONTRADO'; end if;
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se encerra administrativamente titulo que a Conferencia Prime colocou em confirmacao.';
  end if;
  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;
  if v_dec.classe_humana is null then
    raise exception 'SEM_CLASSE_HUMANA: registre primeiro o que apareceu no Prime.';
  end if;
  if v_dec.classe_humana not in ('CANCELAMENTO_ESTORNO','ISENCAO_FIES_BOLSA') then
    raise exception 'CLASSE_NAO_ADMINISTRATIVA: % nao encerra administrativamente (so CANCELAMENTO_ESTORNO ou ISENCAO_FIES_BOLSA).', v_dec.classe_humana;
  end if;

  select count(*) into v_pag0 from public.pagamentos; select count(*) into v_ac0 from public.acordos;
  select count(*) into v_parc0 from public.parcelas; select count(*) into v_vinc0 from public.acordo_titulo_vinculo;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido, v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);
  v_liq := coalesce(v_dec.evidencia->>'liquidado_em', v_dec.evidencia->'prime'->>'liquidado_em', '?');

  -- O TITULO: sai da base por motivo administrativo. Dinheiro intocado.
  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'CANCELADA', status = 'cancelada',
         origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA',
         origem_encerramento_ref = 'conferencia_prime:' || p_titulo_id::text,
         origem_encerramento_em = now(),
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'encerrado administrativamente pela Conferencia Prime: classe humana ' || v_dec.classe_humana
           || '; evidencia: ' || coalesce(v_dec.classe_humana_obs, '-')
           || '; liquidado na Prime em ' || v_liq
           || '; por ' || coalesce(nullif(v_email,''),'gestao') || ' em ' || to_char(now(), 'DD/MM/YYYY HH24:MI')
           || '; obs: ' || v_obs || '. Sem pagamento, acordo ou recuperacao.',
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  update public.prime_conferencia_decisao
     set decisao = 'ENCERRADO_ADMINISTRATIVO', motivo = v_obs, decidido_por = nullif(v_email,''), decidido_em = now()
   where titulo_id = p_titulo_id;

  v_ev := public.prime_liquidacao_evidencias(p_titulo_id);
  insert into public.prime_liquidacao_classificacao
    (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, portador, classificacao, nivel_evidencia,
     motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
  values (p_titulo_id, v_titulo.aluno_id, v_titulo.documento, coalesce(v_ev->>'evidencia_chave', v_dec.evidencia_chave, '-'),
          nullif(v_liq,'?')::date, (v_ev->'prime'->>'portador')::int, 'LIQUIDACAO_INSTITUCIONAL', 'DOCUMENTAL',
          'encerramento administrativo: ' || v_dec.classe_humana || ' -- ' || coalesce(v_dec.classe_humana_obs,'-') || ' -- ' || v_obs,
          coalesce(v_ev, '{}'::jsonb) || jsonb_build_object('classe_humana', v_dec.classe_humana, 'classe_humana_obs', v_dec.classe_humana_obs),
          'GESTAO', coalesce(nullif(v_email,''),'gestao'), 'CANCELADA')
  on conflict do nothing;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_titulo.aluno_id::text, 'TITULO_ENCERRADO_ADMINISTRATIVO',
          'Titulo ' || coalesce(v_titulo.documento,'?') || ' (venc. ' || to_char(v_titulo.vencimento,'DD/MM/YYYY')
            || ') encerrado administrativamente pela Conferencia Prime (' || v_dec.classe_humana || '): a divida deixou de ser exigivel por motivo administrativo/academico. '
            || 'Sem pagamento, acordo, baixa ou recuperacao. ' || v_obs,
          'EM_CONFIRMACAO', 'CANCELADA', v_email, v_email, now(), v_valor);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor, 'classe_humana', v_dec.classe_humana,
                             'classe_humana_obs', v_dec.classe_humana_obs, 'observacao', v_obs, 'evidencia', v_dec.evidencia,
                             'sem_efeito_financeiro', true));

  -- O ALUNO: regra normal. Nunca QUITADO por isto.
  v_rec := public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_encerramento_administrativo');
  v_zer := public.prime_conferencia_encerrar_zerado_aluno(v_titulo.aluno_id, 'conferencia_prime_encerramento_administrativo');
  -- Se o recalculo padrao rotulou "sem saldo" como QUITADO e o helper nao
  -- encerrou (aluno travado, p.ex. SUSPENSAO_COBRANCA), o rotulo correto
  -- continua SEM_PENDENCIA: nao houve quitacao.
  update public.alunos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao = null
   where id = v_titulo.aluno_id and situacao_operacional in ('QUITADO','QUITADO_AGUARDANDO_BAIXA');
  update public.casos set situacao_operacional = 'SEM_PENDENCIA', proxima_acao_automatica = null
   where aluno_id = v_titulo.aluno_id and situacao_operacional in ('QUITADO','QUITADO_AGUARDANDO_BAIXA');

  if (select count(*) from public.pagamentos) <> v_pag0 or (select count(*) from public.acordos) <> v_ac0
     or (select count(*) from public.parcelas) <> v_parc0 or (select count(*) from public.acordo_titulo_vinculo) <> v_vinc0 then
    raise exception 'TRAVA: encerramento administrativo criou pagamento/acordo/parcela/vinculo';
  end if;
  if (select situacao||'/'||status from public.acordos_titulos where id = p_titulo_id) <> 'CANCELADA/cancelada' then
    raise exception 'TRAVA: titulo nao ficou CANCELADA/cancelada';
  end if;

  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id, 'decisao', 'ENCERRADO_ADMINISTRATIVO',
                            'situacao_titulo', 'CANCELADA', 'classe_humana', v_dec.classe_humana, 'valor', v_valor,
                            'aluno', (select situacao_operacional from public.alunos where id = v_titulo.aluno_id),
                            'aluno_recalculo', v_rec->>'situacao', 'caso', v_zer, 'efeito_financeiro', 'nenhum');
end;
$function$;
grant execute on function public.prime_conferencia_encerrar_administrativo(uuid, text) to authenticated, service_role;

-- ===== 6. CARTEIRA 2026/1: CANCELADA = FORA_DA_BASE =========================
create or replace function public.carteira_2026_1_classificar()
 returns table(titulo_id uuid, cpf text, aluno_id uuid, documento text, vencimento date, entrada_em date, valor_original numeric, situacao_crm text, estado_prime text, faixa text, sub_faixa text, acordo_estado text, ef_pago numeric, ef_negociado numeric, ef_convertido numeric, em_validacao numeric, academico numeric, inadimplencia numeric, recuperacao_financeira numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with serie as (
    select regexp_replace(coalesce(boleto,''), '\D', '', 'g') b, max(liquidado_em) liq
      from public.prime_titulo_semestre where coalesce(semestre,'') <> '' group by 1
  ),
  parc as (
    select acordo_id,
           coalesce(sum(valor) filter (where status = 'PAGO'), 0) pagas,
           coalesce(sum(valor) filter (where status in ('A_VENCER','VENCIDA')), 0) abertas,
           count(*) filter (where status = 'VENCIDA' and vencimento >= current_date - 30) venc_ate30,
           count(*) filter (where status = 'VENCIDA' and vencimento <  current_date - 30) venc_mais30
      from public.parcelas group by 1
  ),
  acordo as (
    select a.id,
           case when coalesce(p.pagas,0) + coalesce(p.abertas,0) > 0
                then coalesce(p.pagas,0) / (coalesce(p.pagas,0) + coalesce(p.abertas,0))
                when a.status = 'QUITADO' then 1 else 0 end ratio,
           case when a.status = 'CANCELADO' then 'cancelado'
                when a.status = 'QUITADO'   then 'quitado'
                when coalesce(p.venc_mais30,0) > 0 then 'quebrado'
                when coalesce(p.venc_ate30,0)  > 0 then 'atraso'
                else 'regular' end estado
      from public.acordos a left join parc p on p.acordo_id = a.id
  ),
  boletos_nossos as (
    select distinct regexp_replace(coalesce(boleto,''), '\D', '', 'g') b
      from public.parcelas where boleto is not null
  ),
  caixa_fora as (
    select lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           min(p.data_pagamento) primeiro
      from public.pagamentos p
      join public.alunos al on al.id = p.aluno_id
      left join boletos_nossos bn
             on bn.b = regexp_replace(coalesce(p.numero_parcela_completo,''), '\D', '', 'g')
     where bn.b is null group by 1
  ),
  cancelado_solto as (
    select lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') cpf,
           array_agg(a.criado_em::date) datas
      from public.acordos a
     where a.status = 'CANCELADO'
       and not exists (select 1 from public.acordos_titulos x where x.acordo_id = a.id)
       and not exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = a.id)
     group by 1
  ),
  academico_cpf as (
    select lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') cpf,
           bool_or(status in ('Anulado','Cancelado')
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') anulado,
           bool_or(status = 'Confirmado'
                   and valid_from >= date '2026-01-01' and valid_from < date '2026-07-01') confirmado
      from public.prime_contratos group by 1
  ),
  base as (
    select b.titulo_id, b.cpf, b.aluno_id, b.documento, b.vencimento, b.entrada_em,
           b.valor_original vo, t.situacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) saldo,
           coalesce(t.acordo_id, v.acordo_id) acordo_id, s.liq,
           (s.liq is not null and s.liq > b.vencimento + 30 and s.liq >= b.entrada_em) liq_real,
           (s.liq is null) sem_linha,
           -- 19/09: CANCELADA e saida administrativa (saiu da base / encerramento
           -- pela Conferencia Prime): fora da base, nunca inadimplencia.
           (upper(coalesce(t.situacao,'')) = 'CANCELADA') fora_da_base
      from public.carteira_2026_1_base b
      join public.acordos_titulos t on t.id = b.titulo_id
      left join public.acordo_titulo_vinculo v on v.titulo_id = b.titulo_id and v.ativo
      left join serie s on s.b = regexp_replace(coalesce(b.documento,''), '\D', '', 'g')
  ),
  marcado as (
    select base.*, ac.ratio, ac.estado,
           ((cf.primeiro is not null and cf.primeiro >= base.liq - 30)
            or (cs.datas is not null
                and exists (select 1 from unnest(cs.datas) d where base.liq between d - 7 and d + 7))) origem_provada,
           (cf.cpf is not null) tem_caixa_fora,
           (coalesce(acd.anulado, false) and not coalesce(acd.confirmado, false)) academico
      from base
      left join acordo ac on ac.id = base.acordo_id
      left join caixa_fora cf on cf.cpf = base.cpf
      left join cancelado_solto cs on cs.cpf = base.cpf
      left join academico_cpf acd on acd.cpf = base.cpf
  )
  select
    titulo_id, cpf, aluno_id, documento, vencimento, entrada_em, vo, situacao,
    case when sem_linha then 'sem linha no Prime'
         when liq_real then 'liquidado no Prime' else 'aberto no Prime' end,
    case when fora_da_base then 'FORA_DA_BASE'
         when acordo_id is not null then 'EFETIVIDADE'
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'EFETIVIDADE'
         when liq_real and origem_provada then 'EFETIVIDADE'
         when liq_real and academico then 'ACADEMICO'
         when liq_real then 'EM_VALIDACAO'
         when tem_caixa_fora then 'EM_VALIDACAO'
         when sem_linha then 'EM_VALIDACAO'
         else 'INADIMPLENCIA' end,
    case when fora_da_base then 'Encerrado administrativamente / fora da base'
         when acordo_id is not null then
           case when coalesce(ratio,0) >= 1 then 'Pago / Quitado'
                when estado = 'regular'   then 'Negociado regular'
                when estado = 'atraso'    then 'Negociado em atraso'
                when estado = 'quebrado'  then 'Acordo quebrado'
                when estado = 'cancelado' then 'Acordo cancelado'
                else 'Negociado regular' end
         when situacao = 'PAGO' and greatest(vo - saldo, 0) > 0 then 'Pago / Quitado'
         when liq_real and origem_provada then 'Convertido com origem comprovada'
         when liq_real and academico then 'Baixa/Ajuste academico'
         when liq_real then 'Liquidado no Prime, origem nao comprovada'
         when tem_caixa_fora then 'Aberto no Prime, mas paga acordo fora do CRM'
         when sem_linha then 'Sem confirmacao do Prime (titulo nao encontrado)'
         else 'Sem pagamento e sem negociacao' end,
    coalesce(estado, 'sem_acordo'),
    case when fora_da_base then 0
         when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end,
    case when fora_da_base then 0
         when acordo_id is not null then vo * (1 - coalesce(ratio,0)) else 0 end,
    case when fora_da_base then 0
         when acordo_id is null and liq_real and origem_provada
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when fora_da_base then 0
         when acordo_id is null and liq_real and not origem_provada and not academico
         then (case when situacao = 'PAGO' then saldo else vo end)
         when acordo_id is null and not liq_real and tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end)
         when acordo_id is null and sem_linha and not tem_caixa_fora
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when fora_da_base then 0
         when acordo_id is null and liq_real and not origem_provada and academico
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when fora_da_base then 0
         when acordo_id is null and not liq_real and not tem_caixa_fora and not sem_linha
         then (case when situacao = 'PAGO' then saldo else vo end) else 0 end,
    case when fora_da_base then 0
         when acordo_id is not null then vo * coalesce(ratio,0)
         when situacao = 'PAGO' then greatest(vo - saldo, 0) else 0 end
  from marcado;
$function$;

-- ===== 7. RECALCULO: encerramento administrativo nunca vira QUITADO =========
-- Regra mais restrita possivel: so muda o ramo "sem saldo" e so para aluno com
-- titulo origem_encerramento = CONFERENCIA_PRIME_ADMINISTRATIVA sem evento
-- financeiro posterior. Zerados historicos e quitacoes reais nao mudam.
-- Texto base = producao de 19/09 (md5 f4e1db1892aad74a64245963459d6715).
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hoje date := current_date;
  v_regras jsonb := coalesce((select valor from public.calibragem_parametros where chave='criticidade_regras'),'{}'::jsonb);
  v_ant int := coalesce((select (valor->>'dias')::int from public.calibragem_parametros where chave='retorno_antecedencia_dias'),2);
  v_fim_mes_dias int := coalesce((v_regras->'pesos'->'fim_mes'->>'dias')::int,5);
  v_fim_mes boolean := (date_trunc('month',now())+interval '1 month - 1 day')::date - hoje <= v_fim_mes_dias;
  v_parc_venc_val numeric := 0; v_parc_fut_val numeric := 0;
  v_venc_qtd int := 0; v_fut_qtd int := 0;
  v_parc_antiga_venc date;
  v_prox_venc date; v_prox_val numeric;
  v_entrada_pend boolean := false;
  v_tit_val numeric := 0; v_tit_venc_val numeric := 0;
  v_conf_pend int := 0;
  v_tit_conf int := 0;
  v_termo_pend boolean := false;
  v_baixa_pend boolean := false;
  v_tem_acordo boolean := false;
  v_saldo_vencido numeric; v_saldo_total numeric;
  v_dias_venc int := 0; v_dias_sem_ac int;
  v_status_acion text; v_ult_acion date; v_acao_massiva boolean := false;
  v_ret_atual date; v_orig_atual text;
  v_lembrete date;
  v_nivel text; v_situacao text; v_proxima text; v_retorno date; v_origem text;
  v_preservar_tabulacao boolean := false; v_proxima_auto text;
  -- 19/09: encerramento administrativo pela Conferencia Prime (CANCELAMENTO_ESTORNO /
  -- ISENCAO_FIES_BOLSA) sem evento financeiro posterior que represente quitacao real
  v_enc_admin boolean := false; v_enc_em timestamptz;
begin
  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;

  select
    coalesce(sum(p.valor) filter (where p.vencimento <  hoje),0),
    coalesce(sum(p.valor) filter (where p.vencimento >= hoje),0),
    count(*) filter (where p.vencimento <  hoje),
    count(*) filter (where p.vencimento >= hoje),
    min(p.vencimento) filter (where p.vencimento < hoje),
    bool_or(p.is_entrada),
    count(*) > 0
  into v_parc_venc_val, v_parc_fut_val, v_venc_qtd, v_fut_qtd, v_parc_antiga_venc, v_entrada_pend, v_tem_acordo
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO');

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
    and p.vencimento >= hoje
  order by p.vencimento asc, p.numero asc
  limit 1;

  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)) filter (where t.vencimento < hoje),0)
  into v_tit_val, v_tit_venc_val
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id
    and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
    and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
    and not exists (
      select 1 from public.acordo_titulo_vinculo v
      join public.acordos a on a.id=v.acordo_id
      where v.titulo_id=t.id and coalesce(v.ativo,true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
    and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento);

  select count(*) into v_conf_pend
  from public.solicitacoes_confirmacao_pagamento
  where aluno_id=p_aluno_id::text and status='AGUARDANDO_CONFIRMACAO';

  -- titulos aguardando a Conferencia Prime (fora do saldo, mas nao quitados)
  select count(*) into v_tit_conf
  from public.acordos_titulos t
  where t.aluno_id=p_aluno_id and upper(coalesce(t.situacao,''))='EM_CONFIRMACAO';

  select coalesce((c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);

  select coalesce((al.status_baixa_pagamento is not null and al.status_baixa_pagamento <> 'BAIXA_REALIZADA'), false)
  into v_baixa_pend from public.alunos al where al.id=p_aluno_id;
  v_baixa_pend := coalesce(v_baixa_pend,false);

  v_saldo_vencido := round(v_parc_venc_val + v_tit_venc_val, 2);
  v_saldo_total   := round(v_parc_venc_val + v_parc_fut_val + v_tit_val, 2);

  -- Regra restrita (19/09): so alunos com titulo encerrado administrativamente
  -- pela Conferencia Prime. "Sem saldo" por esse motivo NAO e quitacao: fica
  -- SEM_PENDENCIA enquanto nao houver evento financeiro POSTERIOR ao
  -- encerramento (caso quitado, titulo pago, acordo quitado ou pagamento).
  select max(t.origem_encerramento_em) into v_enc_em
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id and t.origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA';
  if v_enc_em is not null then
     v_enc_admin := not (
          exists (select 1 from public.casos c where c.aluno_id = p_aluno_id and c.quitado_em is not null)
       or exists (select 1 from public.acordos_titulos t where t.aluno_id = p_aluno_id
                    and upper(coalesce(t.situacao,'')) = 'PAGO' and coalesce(t.atualizado_em, t.created_at) >= v_enc_em)
       or exists (select 1 from public.acordos a where a.aluno_id = p_aluno_id
                    and upper(coalesce(a.status,'')) = 'QUITADO' and a.criado_em >= v_enc_em)
       or exists (select 1 from public.pagamentos p where p.aluno_id = p_aluno_id and p.data_pagamento >= v_enc_em::date));
  end if;

  v_dias_venc := case
    when v_parc_antiga_venc is not null then (hoje - v_parc_antiga_venc)
    else coalesce((select hoje - min(t.vencimento) from public.acordos_titulos t
                   where t.aluno_id=p_aluno_id and t.vencimento < hoje
                     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
                     and not exists (
                       select 1 from public.acordo_titulo_vinculo v
                       join public.acordos a on a.id=v.acordo_id
                       where v.titulo_id=t.id and coalesce(v.ativo,true)
                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
                     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)),0)
  end;
  if v_dias_venc < 0 then v_dias_venc := 0; end if;

  select
    case when data_ultimo_acionamento is null then 9999 else (hoje - data_ultimo_acionamento::date) end,
    data_ultimo_acionamento::date,
    coalesce(status_acionamento,'') ilike 'Ação massiva%',
    data_retorno,
    retorno_origem
  into v_dias_sem_ac, v_ult_acion, v_acao_massiva, v_ret_atual, v_orig_atual
  from public.alunos where id=p_aluno_id;
  v_dias_sem_ac := coalesce(v_dias_sem_ac, 9999);

  if v_saldo_total <= 0.005 and v_conf_pend = 0 and v_tit_conf > 0 then
     -- So resta titulo aguardando a Conferencia Prime: nao e quitacao.
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel    := 'NORMAL';
     v_proxima  := 'Próxima ação: aguardar a decisão da Conferência Prime sobre a liquidação do título.';
     v_retorno  := null; v_origem := null;
  elsif v_saldo_total <= 0.005 and v_conf_pend = 0 then
     v_nivel := 'NORMAL';
     if v_baixa_pend then
        v_situacao := 'QUITADO_AGUARDANDO_BAIXA';
        v_proxima  := 'Próxima ação: concluir a baixa e finalizar o caso.';
     elsif v_enc_admin then
        -- sem saldo por encerramento administrativo: nao houve quitacao
        v_situacao := 'SEM_PENDENCIA';
        v_proxima  := null;
     else
        v_situacao := 'QUITADO';
        v_proxima  := null;
     end if;
     v_retorno := null; v_origem := null;
  elsif v_conf_pend > 0 and v_saldo_vencido <= 0.005 then
     v_situacao := 'AGUARDANDO_CONFIRMACAO';
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'ATENCAO');
     v_proxima := 'Próxima ação: confirmar o pagamento no financeiro.';
     v_retorno := null; v_origem := null;
  elsif v_saldo_vencido > 0.005 then
     v_nivel := public.calibragem_nivel_criticidade(v_dias_venc, v_dias_sem_ac, v_saldo_total, v_termo_pend, v_fim_mes, v_regras);
     v_situacao := 'COBRANCA_VENCIDA';
     v_proxima := 'Próxima ação: cobrar o saldo vencido de '||public.fmt_brl(v_saldo_vencido)||'.';
     if v_conf_pend > 0 then
        -- Está com o financeiro: o caso fica parado até a conferência ser
        -- concluída. Sem prazo empurrando ele de volta para o operador.
        v_proxima := 'Próxima ação: aguardar a confirmação do pagamento no financeiro'
                  || ' (saldo vencido de '||public.fmt_brl(v_saldo_vencido)||' segue em aberto).';
        v_retorno := null; v_origem := null;
     elsif v_acao_massiva and v_ult_acion is not null and (hoje - v_ult_acion) < 10 then
        v_retorno := v_ult_acion + 10;
        v_origem  := 'AUTOMATICO';
     elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     end if;
  elsif v_parc_fut_val > 0.005 and v_prox_venc is not null then
     v_nivel := 'NORMAL';
     v_situacao := 'ACORDO_EM_DIA';
     v_proxima := 'Próxima ação: lembrar o aluno da parcela de '||public.fmt_brl(coalesce(v_prox_val,0))
                ||' com vencimento em '||to_char(v_prox_venc,'DD/MM/YYYY')||'.';
     v_lembrete := public.dia_util_anterior_ou_igual(v_prox_venc - v_ant);
     if v_ret_atual is not null and v_ret_atual > hoje and coalesce(v_orig_atual,'') like 'OPERADOR%' then
        v_retorno := v_ret_atual;
        v_origem  := v_orig_atual;
     elsif v_ult_acion is not null and v_ult_acion >= v_lembrete then
        v_retorno := null;
        v_origem  := null;
     else
        v_retorno := greatest(hoje, v_lembrete);
        v_origem  := 'AUTOMATICO';
     end if;
  else
     v_nivel := coalesce((select criticidade from public.casos where aluno_id=p_aluno_id limit 1),'NORMAL');
     v_situacao := 'SEM_PENDENCIA';
     v_proxima := null;
     v_retorno := null; v_origem := null;
  end if;

  -- Acionado hoje: o desfecho tabulado pelo operador manda na fila.
  v_proxima_auto := v_proxima;  -- casos.proxima_acao_automatica segue automatica
  v_preservar_tabulacao := (v_ult_acion = hoje)
    and v_conf_pend = 0
    and v_situacao not in ('QUITADO','QUITADO_AGUARDANDO_BAIXA','AGUARDANDO_CONFIRMACAO');
  if v_preservar_tabulacao then
     select al.proxima_acao, al.data_retorno, al.retorno_origem
       into v_proxima, v_retorno, v_origem
       from public.alunos al where al.id = p_aluno_id;
  end if;
  update public.casos set
     criticidade            = v_nivel,
     situacao_operacional   = v_situacao,
     proxima_acao_automatica= coalesce(v_proxima_auto, v_proxima),
     proximo_vencimento     = coalesce(v_prox_venc, v_parc_antiga_venc, proximo_vencimento),
     parcela_a_vencer       = v_prox_val,
     parcelas_vencidas      = v_venc_qtd,
     saldo_vencido          = v_saldo_vencido,
     saldo_total            = v_saldo_total,
     data_retorno           = v_retorno,
     caso_atualizado_em     = now()
   where aluno_id = p_aluno_id;

  update public.alunos set
     nivel_criticidade    = v_nivel,
     situacao_operacional = v_situacao,
     proxima_acao         = v_proxima,
     saldo_vencido        = v_saldo_vencido,
     saldo_total          = v_saldo_total,
     data_retorno         = v_retorno,
     retorno_origem       = v_origem
   where id = p_aluno_id;

  if v_situacao='ACORDO_EM_DIA' and v_prox_venc is not null then
     insert into public.retorno_acordo_auto(aluno_id, proximo_vencimento, data_retorno, valor, lote)
     values (p_aluno_id, v_prox_venc, coalesce(v_retorno, v_lembrete), v_prox_val, coalesce(p_lote,'evento'))
     on conflict (aluno_id, proximo_vencimento)
       do update set data_retorno=excluded.data_retorno, valor=excluded.valor, gerado_em=now();
  end if;

  return jsonb_build_object(
    'aluno_id',p_aluno_id,'situacao',v_situacao,'criticidade',v_nivel,
    'proxima_acao',v_proxima,'data_retorno',v_retorno,'retorno_origem',v_origem,
    'lembrete_parcela',v_lembrete,
    'saldo_vencido',v_saldo_vencido,'saldo_total',v_saldo_total,
    'proxima_parcela_venc',v_prox_venc,'proxima_parcela_valor',v_prox_val,
    'confirmacao_pendente',v_conf_pend>0,'termo_pendente',v_termo_pend,
    'entrada_pendente',coalesce(v_entrada_pend,false),'baixa_pendente',v_baixa_pend,
    'tem_acordo',coalesce(v_tem_acordo,false),
    'titulos_em_confirmacao',v_tit_conf,'encerramento_administrativo',v_enc_admin);
end; $function$;

-- ===== 8. PROVA: nada de dado mudou =========================================
do $prova$
declare a record; d record;
begin
  select * into a from _ea_antes;
  select (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
         (select count(*) from public.acordos_titulos where situacao='EM_CONFIRMACAO') em_conf,
         (select count(*) from public.acordos_titulos where situacao='CANCELADA') canceladas,
         (select count(*) from public.acordos_titulos where situacao='PAGO') pagos,
         (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
         (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc
    into d;
  if to_jsonb(a) <> to_jsonb(d) then
    raise exception 'ENCERRAMENTO_ADMINISTRATIVO: a migration mexeu em dado (antes % / depois %)', to_jsonb(a), to_jsonb(d);
  end if;
  if exists (select 1 from public.acordos_titulos where origem_encerramento is not null) then
    raise exception 'ENCERRAMENTO_ADMINISTRATIVO: proveniencia nao pode existir antes da primeira execucao';
  end if;
  if position('FORA_DA_BASE' in (select prosrc from pg_proc where proname='carteira_2026_1_classificar')) = 0
     or position('CANCELADA' in (select prosrc from pg_proc where proname='_trg_auto_quitar_titulo')) = 0
     or position('v_enc_admin' in (select prosrc from pg_proc where proname='recalcular_situacao_aluno')) = 0 then
    raise exception 'ENCERRAMENTO_ADMINISTRATIVO: ajuste de metrica/quitacao ausente';
  end if;
end
$prova$;

commit;
