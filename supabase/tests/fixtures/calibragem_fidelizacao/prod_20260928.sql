-- FIXTURE GERADA A PARTIR DA PRODUCAO em 2026-09-28 (somente leitura: pg_get_functiondef).
--
-- Camada de CALIBRAGEM por cima de supabase/tests/fixtures/protecao_confirmacao_prod_20260920.sql
-- (que traz as tabelas de producao e os auxiliares normalizar_status_acionamento,
--  saldo_titulos_aberto, caso_aguarda_confirmacao_financeira, caso_dentro_prazo_fidelizacao,
--  caso_encerrado_operacional e calibragem_e_gestao -- md5 conferidos hoje, iguais aos de 20/09).
--
-- O UNICO corpo do arquivo base que mudou desde 20/09 e caso_protegido_redistribuicao
-- (md5 11caab2c... -> 1c00d3fb...): ele e reemitido aqui, com o texto de HOJE.
--
-- Funcoes: texto EXATO de producao, conferido por md5 do prosrc (prod_20260928.md5.json).
-- Tabelas de calibragem: colunas e tipos de producao. calibragem_saldo_aluno (a view
-- real que alimenta o pool do giro) ja vem do arquivo base.
-- STUB de infraestrutura (NAO e regra de negocio): exigir_capacidade() (disjuntor de carga).
-- NENHUM DADO REAL.

create table public.calibragem_simulacoes (
  "id" uuid default gen_random_uuid() primary key,
  "criado_por_email" text,
  "criado_por_nome" text,
  "criterios" jsonb,
  "resultado" jsonb,
  "status" text,
  "aprovado_por_email" text,
  "aprovado_por_nome" text,
  "aprovado_em" timestamp with time zone,
  "executado_em" timestamp with time zone,
  "observacao" text,
  "criado_em" timestamp with time zone default now()
);

create table public.calibragem_auditoria (
  "id" uuid default gen_random_uuid() primary key,
  "evento" text,
  "simulacao_id" uuid,
  "caso_id" uuid,
  "chave_unificacao" text,
  "aluno_id" uuid,
  "cpf" text,
  "nome_aluno" text,
  "operador_anterior_email" text,
  "operador_anterior_nome" text,
  "operador_novo_email" text,
  "operador_novo_nome" text,
  "valor_caso" numeric,
  "motivo" text,
  "regra" text,
  "caso_compensacao_id" uuid,
  "situacao_anterior" jsonb,
  "situacao_posterior" jsonb,
  "aprovado_por_email" text,
  "aprovado_por_nome" text,
  "registrado_por_email" text,
  "registrado_em" timestamp with time zone default now()
);

-- Coluna de producao que o arquivo base (20/09) nao tem.
alter table public.usuarios add column if not exists recebe_novos_casos boolean default true;

-- STUB de infraestrutura: o disjuntor de carga le pg_stat_activity.
create or replace function public.exigir_capacidade(p_acao text default null)
returns void language sql as $$ select null::void $$;

-- ---------------------------------------------------------------------------
-- caso_protegido_redistribuicao: TEXTO DE HOJE (substitui o do arquivo base).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text DEFAULT NULL::text, p_valor_pago numeric DEFAULT NULL::numeric, p_quitado_em date DEFAULT NULL::date, p_valor_quitado numeric DEFAULT NULL::numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL'];
begin
  if coalesce(p_nao_acionar, false) then return true; end if;

  if v_status_norm = any(bloq) or v_status_fin_norm = any(bloq) then
    return true;
  end if;

  -- Caso cujo unico saldo esta em titulo aguardando a Conferencia Prime: nao
  -- ocupa vaga (teto, reposicao, nivelamento), nao e redistribuido e nao e
  -- solto pela fidelizacao -- o responsavel fica para quando houver decisao.
  -- (o aluno e achado pelo CPF normalizado da ficha -- indice
  -- idx_alunos_cpf_normalizado; o CPF gravado no titulo pode divergir)
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.acordos_titulos t
                       where t.aluno_id = al.id
                         and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
          and public.caso_aguarda_confirmacao_financeira(al.id)) then
    return true;
  end if;

  -- CONFIRMACAO FINANCEIRA ABERTA (solicitacoes_confirmacao_pagamento), pelo
  -- aluno_id da solicitacao -- NAO por solicitacoes.aluno_cpf, que e nulo em
  -- 345 das 351 abertas. Os dois estados abertos protegem. Sem nome, sem
  -- aproximacao: aluno pelo CPF normalizado da ficha (mesma chave do bloco acima),
  -- solicitacao por aluno_id (texto, indexado).
  if v_cpf <> '00000000000' and v_cpf <> '' and exists (
       select 1 from public.alunos al
        where lpad(regexp_replace(coalesce(al.cpf, ''), '\D', '', 'g'), 11, '0') = v_cpf
          and exists (select 1 from public.solicitacoes_confirmacao_pagamento s
                       where s.aluno_id = al.id::text
                         and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))) then
    return true;
  end if;

  if v_cpf = '00000000000' or v_cpf = '' then
    null;
  elsif exists (select 1 from public.acordos a where a.cpf = v_cpf and a.status = 'ATIVO')
     or exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = v_cpf and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- pagamento em transito: protege sempre
     or exists (select 1 from public.links_pagamento l where l.aluno_cpf = v_cpf and l.status = 'AGUARDANDO_BAIXA')
     -- link vivo: protege por um dia
     or exists (select 1 from public.links_pagamento l
                 where l.aluno_cpf = v_cpf
                   and l.status in ('LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO')
                   and coalesce(l.enviado_ao_aluno_em, l.enviado_em, l.criado_em)::date >= current_date - 1)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_cpf = v_cpf and s.status = 'AGUARDANDO_CONFIRMACAO')
  then
    return true;
  end if;

  if (v_status_norm = any(quit) or v_status_fin_norm = any(quit)
      or coalesce(p_valor_pago,0) > 0 or p_quitado_em is not null or coalesce(p_valor_quitado,0) > 0)
     and public.saldo_titulos_aberto(v_cpf) = 0
  then
    return true;
  end if;

  if v_status_norm in (
    'ACORDO FECHADO','ACORDO EM ANDAMENTO','EM NEGOCIACAO',
    'AGUARDANDO PAGAMENTO','AGUARDANDO FINANCEIRO','EMAIL ENVIADO AO FINANCEIRO','E MAIL ENVIADO FINANC',
    'LINK CARTAO ENVIADO','PAGO PARCIAL','VALORES ENVIADOS','PROPOSTA ENVIADA','PROPOSTA DE EXCECAO',
    'TERMO ENVIADO','TERMO RECEBIDO','EM TRATATIVA','RETORNO AGENDADO'
  ) then
    return true;
  end if;

  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_indice_equilibrio(p_vals numeric[])
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare v_avg numeric; v_sd numeric; v_cv numeric;
begin
  if p_vals is null or array_length(p_vals,1) is null or array_length(p_vals,1) < 2 then return 100; end if;
  select avg(v), coalesce(stddev_pop(v),0) into v_avg, v_sd from unnest(p_vals) v;
  if coalesce(v_avg,0) = 0 then return 100; end if;
  v_cv := v_sd / v_avg;
  return greatest(0, round((1 - v_cv) * 100, 1));
end; $function$;

CREATE OR REPLACE FUNCTION public.calibragem_simular_giro_2026(p_criterio jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ano   int  := coalesce(nullif(p_criterio->>'ano','')::int, 2026);
  v_ops   text[];
  v_n_ops int;
  v_sim_id uuid;
  v_resultado jsonb;
  v_ia_qtd numeric; v_id_qtd numeric; v_ia_sal numeric; v_id_sal numeric;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para simular o giro de carteira.';
  end if;

  if p_criterio ? 'operadores' then
    v_ops := array(select jsonb_array_elements_text(p_criterio->'operadores'));
    if array_length(v_ops,1) is null then v_ops := null; end if;
  end if;

  create temp table _ops on commit drop as
  select row_number() over (order by u.email) - 1 as slot, u.email, u.nome
    from public.usuarios u
   where u.ativo and u.perfil = 'operador'
     and (v_ops is null or u.email = any(v_ops));
  select count(*) into v_n_ops from _ops;
  if v_n_ops = 0 then raise exception 'Nenhum operador ativo para receber o giro.'; end if;

  create temp table _caso on commit drop as
  select c.id caso_id, c.aluno_id,
         c.operador_email de_email, c.operador_nome de_nome,
         coalesce(nullif(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D', '', 'g'), ''), 'caso:' || c.id::text) cpf_chave,
         coalesce(c.cpf_limpo, c.cpf) cpf,
         coalesce(c.nome, c.nome_aluno) nome,
         round(coalesce(s.saldo_mensalidade,0),2) valor,
         s.venc_max
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where coalesce(s.saldo_mensalidade,0) > 0
     and coalesce(s.saldo_acordo,0) = 0
     and not public.caso_protegido_redistribuicao(
           c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
     -- Caso concluido nao e carteira: fica de fora da contagem e do giro.
     and not public.caso_encerrado_operacional(
           c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);

  create temp table _cpf on commit drop as
  select cpf_chave,
         max(venc_max) venc_max,
         round(sum(valor),2) valor,
         count(*) qtd_casos
    from _caso
   group by cpf_chave;

  alter table _cpf add column semestre text;
  alter table _cpf add column slot int;
  update _cpf set semestre = case
      when venc_max is null                     then 'ANTERIOR'
      when venc_max <  make_date(v_ano,1,1)     then 'ANTERIOR'
      when venc_max <  make_date(v_ano,7,1)     then v_ano || '/1'
      when venc_max <  make_date(v_ano+1,1,1)   then v_ano || '/2'
      else 'POSTERIOR' end;

  with fila as (
    select cpf_chave,
           row_number() over (partition by semestre order by valor desc, cpf_chave) - 1 r
      from _cpf
     where semestre in (v_ano || '/1', v_ano || '/2')
  )
  update _cpf c
     set slot = case when (f.r / v_n_ops) % 2 = 0
                     then  f.r % v_n_ops
                     else  v_n_ops - 1 - (f.r % v_n_ops) end
    from fila f where f.cpf_chave = c.cpf_chave;

  create temp table _mov on commit drop as
  select ca.caso_id, ca.cpf, ca.nome, ca.valor, ca.de_email, ca.de_nome,
         cp.semestre, o.email para_email, o.nome para_nome,
         case when cp.semestre in ('ANTERIOR','POSTERIOR') then 'Retirado do giro: dívida fora de ' || v_ano
              when ca.de_email is null then 'Giro ' || cp.semestre || ': recebido do pool'
              else 'Giro ' || cp.semestre || ': carteira redistribuída' end motivo
    from _caso ca
    join _cpf  cp on cp.cpf_chave = ca.cpf_chave
    left join _ops o on o.slot = cp.slot;

  create temp table _antes on commit drop as
  select o.email op_email, o.nome op_nome,
         count(m.caso_id)::numeric qtd,
         round(coalesce(sum(m.valor),0),2) saldo
    from _ops o left join _mov m on m.de_email = o.email
   group by o.email, o.nome;

  create temp table _depois on commit drop as
  select o.email op_email, o.nome op_nome,
         count(m.caso_id)::numeric qtd,
         count(distinct m.cpf)::numeric cpfs,
         round(coalesce(sum(m.valor),0),2) saldo,
         count(m.caso_id) filter (where m.semestre = v_ano || '/1')::numeric qtd_s1,
         round(coalesce(sum(m.valor) filter (where m.semestre = v_ano || '/1'),0),2) saldo_s1,
         count(m.caso_id) filter (where m.semestre = v_ano || '/2')::numeric qtd_s2,
         round(coalesce(sum(m.valor) filter (where m.semestre = v_ano || '/2'),0),2) saldo_s2
    from _ops o left join _mov m on m.para_email = o.email
   group by o.email, o.nome;

  v_ia_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _antes));
  v_ia_sal := public.calibragem_indice_equilibrio(array(select saldo from _antes));
  v_id_qtd := public.calibragem_indice_equilibrio(array(select qtd   from _depois));
  v_id_sal := public.calibragem_indice_equilibrio(array(select saldo from _depois));

  select jsonb_build_object(
    'criterio', p_criterio, 'metrica', 'GIRO_2026', 'ano', v_ano,
    'operadores', v_n_ops,
    'ignora_fidelizacao', true,
    'indice_antes', v_ia_sal, 'indice_depois', v_id_sal,
    'indice_qtd_antes', v_ia_qtd, 'indice_qtd_depois', v_id_qtd,
    'resumo', (select jsonb_object_agg(semestre, jsonb_build_object(
                 'casos', qtd, 'cpfs', cpfs, 'valor', valor))
                 from (select semestre, sum(qtd_casos) qtd, count(*) cpfs,
                              round(sum(valor),2) valor
                         from _cpf group by semestre) t),
    'antes',  (select coalesce(jsonb_agg(jsonb_build_object(
                 'op_email',op_email,'op_nome',op_nome,'qtd',qtd,'saldo',saldo) order by op_nome),'[]') from _antes),
    'depois', (select coalesce(jsonb_agg(jsonb_build_object(
                 'op_email',op_email,'op_nome',op_nome,'qtd',qtd,'cpfs',cpfs,'saldo',saldo,
                 'qtd_s1',qtd_s1,'saldo_s1',saldo_s1,'qtd_s2',qtd_s2,'saldo_s2',saldo_s2) order by op_nome),'[]') from _depois),
    'movimentacoes', (select coalesce(jsonb_agg(jsonb_build_object(
        'caso_id',caso_id,'cpf',cpf,'nome',nome,'valor',valor,
        'de_email',de_email,'de_nome',de_nome,
        'para_email',para_email,'para_nome',para_nome,
        'motivo',motivo) order by para_email nulls last, valor desc),'[]')
      from _mov where para_email is distinct from de_email),
    'total_movimentacoes', (select count(*) from _mov where para_email is distinct from de_email),
    'total_retiradas', (select count(*) from _mov where para_email is null and de_email is not null)
  ) into v_resultado;

  insert into public.calibragem_simulacoes(criado_por_email, criado_por_nome, criterios, resultado, status)
  values (coalesce(auth.jwt()->>'email','server'), coalesce(auth.jwt()->>'email','server'),
          p_criterio || jsonb_build_object('tipo','GIRO_2026'), v_resultado, 'RASCUNHO')
  returning id into v_sim_id;

  return jsonb_build_object('simulacao_id', v_sim_id) || v_resultado;
end;
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_executar_giro_lote_impl(p_id uuid, p_tamanho integer DEFAULT 150)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_movidos int := 0; v_pulados int := 0; v_total int; v_feitos int; v_restantes int;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para executar o giro de carteira.';
  end if;
  if p_tamanho is null or p_tamanho < 1 then p_tamanho := 150; end if;

  select * into v_sim from public.calibragem_simulacoes where id = p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if coalesce(v_sim.resultado->>'metrica','') <> 'GIRO_2026' then
    raise exception 'Esta simulação não é um giro de carteira.';
  end if;
  if v_sim.status not in ('APROVADA','EXECUTANDO') then
    raise exception 'Simulação precisa estar APROVADA ou EXECUTANDO (atual: %).', v_sim.status;
  end if;

  perform pg_advisory_xact_lock(hashtext('calibragem_executar_nivelamento'));
  if v_sim.status = 'APROVADA' then
    update public.calibragem_simulacoes set status='EXECUTANDO' where id=p_id;
  end if;

  select count(distinct (m->>'caso_id')) into v_total
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;

  perform set_config('calibragem.bypass_teto','on', true);

  create temp table _slice on commit drop as
  select (m->>'caso_id')::uuid caso_id, nullif(m->>'de_email','') de_email, m->>'de_nome' de_nome,
         nullif(m->>'para_email','') para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
    from jsonb_array_elements(v_sim.resultado->'movimentacoes') m
   where not exists (
     select 1 from public.calibragem_auditoria a
      where a.simulacao_id = p_id and a.caso_id = (m->>'caso_id')::uuid
        and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO'))
   order by (m->>'caso_id')
   limit p_tamanho;

  update _slice e set valido = true from public.casos c
   where c.id = e.caso_id
     and c.operador_email is not distinct from e.de_email
     and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
           c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado);

  update public.casos c
     set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por giro de carteira', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _slice e where e.valido and c.id = e.caso_id and e.de_email is not null;

  update public.casos c
     set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _slice e where e.valido and c.id = e.caso_id and e.para_email is not null;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'MOVIMENTACAO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor, e.motivo, 'GIRO_2026',
    jsonb_build_object('operador_email', e.de_email, 'operador_nome', e.de_nome),
    jsonb_build_object('operador_email', e.para_email, 'operador_nome', e.para_nome,
                       'marcador','Retirado por giro de carteira'),
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e join public.casos c on c.id = e.caso_id where e.valido;
  get diagnostics v_movidos = row_count;

  insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
    operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
    valor_caso, motivo, regra, situacao_anterior, situacao_posterior,
    aprovado_por_email, aprovado_por_nome, registrado_por_email)
  select 'PULADO_NIVELAMENTO', p_id, e.caso_id, c.aluno_id, e.cpf, e.nome,
    e.de_email, e.de_nome, e.para_email, e.para_nome, e.valor,
    'Pulado no giro: o caso já não pertence ao operador de origem ou ficou protegido (negociação, acordo, link, termo, pagamento).',
    'GIRO_2026', '{}'::jsonb, '{}'::jsonb,
    v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email
    from _slice e left join public.casos c on c.id = e.caso_id where not e.valido;
  get diagnostics v_pulados = row_count;

  select count(distinct a.caso_id) into v_feitos
    from public.calibragem_auditoria a
   where a.simulacao_id = p_id and a.evento in ('MOVIMENTACAO_NIVELAMENTO','PULADO_NIVELAMENTO');
  v_restantes := greatest(v_total - v_feitos, 0);

  if v_restantes = 0 then
    update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  end if;

  return jsonb_build_object('id', p_id, 'movidos_lote', v_movidos, 'pulados_lote', v_pulados,
    'feitos', v_feitos, 'restantes', v_restantes, 'total', v_total, 'concluido', v_restantes = 0);
end;
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_executar_giro_lote(p_id uuid, p_tamanho integer DEFAULT 150)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.exigir_capacidade('executar giro de carteira em lote');
  return public.calibragem_executar_giro_lote_impl(p_id, p_tamanho);
end;
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_executar_acordos(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server'); v_exec int := 0; v_pul int := 0; r record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar acordos.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  if upper(coalesce(v_sim.resultado->>'metrica','')) <> 'ACORDOS' then raise exception 'Esta simulação não é de acordos.'; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_acordos'));
  for r in select x.* from jsonb_array_elements(v_sim.resultado->'movimentacoes') m,
      lateral (select (m->>'acordo_id')::uuid acordo_id, m->>'de_email' de_email, m->>'para_email' para_email, m->>'para_nome' para_nome, m->>'de_nome' de_nome, (m->>'valor')::numeric valor, m->>'cpf' cpf, m->>'nome' nome) x
  loop
    if not exists (select 1 from public.acordos a where a.id=r.acordo_id and a.operador_responsavel_email=r.de_email and upper(coalesce(a.status,''))='ATIVO') then v_pul := v_pul + 1; continue; end if;
    update public.acordos set operador_responsavel_email=r.para_email, operador_responsavel_nome=r.para_nome, atualizado_em=now() where id=r.acordo_id;
    insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, cpf, nome_aluno, operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome, valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values ('MOVIMENTACAO_NIVELAMENTO_ACORDO', p_id, r.acordo_id, r.cpf, r.nome, r.de_email, r.de_nome, r.para_email, r.para_nome, r.valor, r.motivo, 'ACORDOS',
      jsonb_build_object('acordo_id', r.acordo_id, 'operador_email', r.de_email), jsonb_build_object('acordo_id', r.acordo_id, 'operador_email', r.para_email),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_exec := v_exec + 1;
  end loop;
  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_exec, 'pulados', v_pul);
end; $function$;

CREATE OR REPLACE FUNCTION public.calibragem_executar_simulacao(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sim record; v_email text := coalesce(auth.jwt() ->> 'email','server');
  v_executados int := 0; v_pulados int := 0; r record; v_aluno uuid;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para executar a Calibragem.'; end if;
  select * into v_sim from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_sim.status <> 'APROVADA' then raise exception 'Simulação precisa estar APROVADA (atual: %).', v_sim.status; end if;
  perform pg_advisory_xact_lock(hashtext('calibragem_executar_simulacao'));
  create temp table _exec on commit drop as
  select (m->>'caso_id')::uuid caso_id, m->>'de_email' de_email, m->>'de_nome' de_nome,
         m->>'para_email' para_email, m->>'para_nome' para_nome, (m->>'valor')::numeric valor,
         m->>'motivo' motivo, m->>'cpf' cpf, m->>'nome' nome, false as valido
  from jsonb_array_elements(v_sim.resultado->'movimentacoes') m;
  update _exec e set valido = true from public.casos c
  where c.id = e.caso_id and c.operador_email = e.de_email
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    -- Acionado depois da simulacao? Voltou a ter dono pelos 10 dias: nao move.
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento);
  select count(*) filter (where not valido) into v_pulados from _exec;
  update public.casos c set operador_email=null, operador_nome=null, operador=null,
         nivelamento_marcador='Retirado por nivelamento', nivelamento_em=now(), nivelamento_simulacao_id=p_id
    from _exec e where e.valido and c.id = e.caso_id;
  update public.casos c set operador_email=e.para_email, operador_nome=e.para_nome, operador=upper(coalesce(e.para_nome,''))
    from _exec e where e.valido and c.id = e.caso_id;
  for r in select * from _exec where valido loop
    select c.aluno_id into v_aluno from public.casos c where c.id = r.caso_id;
    insert into public.calibragem_auditoria(evento, simulacao_id, caso_id, aluno_id, cpf, nome_aluno,
      operador_anterior_email, operador_anterior_nome, operador_novo_email, operador_novo_nome,
      valor_caso, motivo, regra, situacao_anterior, situacao_posterior, aprovado_por_email, aprovado_por_nome, registrado_por_email)
    values ('MOVIMENTACAO_NIVELAMENTO', p_id, r.caso_id, v_aluno, r.cpf, r.nome, r.de_email, r.de_nome, r.para_email, r.para_nome,
      r.valor, r.motivo, upper(coalesce(v_sim.resultado->>'metrica','SALDO')),
      jsonb_build_object('operador_email', r.de_email, 'operador_nome', r.de_nome),
      jsonb_build_object('operador_email', r.para_email, 'operador_nome', r.para_nome, 'marcador','Retirado por nivelamento'),
      v_sim.aprovado_por_email, v_sim.aprovado_por_nome, v_email);
    v_executados := v_executados + 1;
  end loop;
  update public.calibragem_simulacoes set status='EXECUTADA', executado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'EXECUTADA', 'executados', v_executados, 'pulados', v_pulados);
end; $function$;

-- ---------------------------------------------------------------------------
-- FIDELIZACAO: o cron que solta e a rotina diaria de nivelamento da gestao.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION internal.carteira_geral_email()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select 'carteira.geral@reativa.local'::text $function$;

CREATE OR REPLACE FUNCTION public.usuario_e_gestao_fila()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.usuario_e_gestao()
  OR EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
      AND u.perfil IN ('gerencia','supervisor','administrativo')
  );
$function$;

CREATE OR REPLACE FUNCTION public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null and lower(c.operador_email) <> internal.carteira_geral_email()
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$;

CREATE OR REPLACE FUNCTION public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text DEFAULT 'FIDELIZACAO_EXPIRADA'::text, p_autor text DEFAULT 'sistema_fidelizacao'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_c record;
begin
  select * into v_c from public.casos where id = p_caso_id for update;
  if not found or v_c.operador_email is null then return false; end if;
  update public.casos set operador_email=null, operador_nome=null, operador=null,
    caso_atualizado_por=p_autor, caso_atualizado_em=now()
  where id = p_caso_id;
  if v_c.aluno_id is not null then
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null
    where id = v_c.aluno_id;
  end if;
  insert into public.historico_operadores_alunos
    (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  values (v_c.chave_unificacao, v_c.nome, v_c.cpf, p_motivo, v_c.operador_nome, v_c.operador_email,
    'Fidelizacao expirada (ultimo acionamento '||coalesce(v_c.data_ultimo_acionamento::text,'nunca')||' + 10d). Caso LIVRE, sem atribuicao automatica. Responsavel anterior preservado.', now());
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.liberar_casos_fidelizacao_vencida(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare v_rec record; v_total int := 0;
begin
  if auth.jwt() is not null and not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;
  for v_rec in select * from public.casos_elegiveis_liberacao_fidelizacao() limit coalesce(p_limite, 100000)
  loop
    if public.liberar_fidelizacao_caso(v_rec.caso_id, 'FIDELIZACAO_EXPIRADA', 'fidelizacao_expirada_lote') then
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nivelamento_automatico_gestao(p_dias integer DEFAULT 10, p_aplicar boolean DEFAULT true, p_origens text[] DEFAULT ARRAY['amanda.seibel@aelbra.com.br'::text])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_res jsonb; v_movidos int := 0; v_caso record; v_dest record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para nivelar a base da gestão.';
  end if;
  p_dias := greatest(coalesce(p_dias, 10), 0);

  create temp table _eleg on commit drop as
  select c.id caso_id, c.aluno_id, c.chave_unificacao, coalesce(c.nome, c.nome_aluno) nome,
         c.cpf, c.operador_email de_email,
         exists (select 1 from public.acordos a where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'),11,'0') and a.status = 'ATIVO') tem_acordo,
         round(coalesce(s.saldo_total,0),2) valor
    from public.casos c
    join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
   where c.operador_email = any(p_origens)
     and coalesce(s.saldo_total,0) > 0
     and not coalesce(c.nao_acionar, false)
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
     and not exists (select 1 from public.links_pagamento l where l.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and l.status in ('AGUARDANDO_BAIXA','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO'))
     and not exists (select 1 from public.baixas_pagamento b where b.aluno_cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0')
                       and b.status_baixa = 'AGUARDANDO_BAIXA')
     -- confirmacao financeira aberta, pelo aluno_id (solicitacoes.aluno_cpf e nulo em 345 das 351 abertas)
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento sc where sc.aluno_id = c.aluno_id::text
                       and sc.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
     and (
       exists (select 1 from public.acordos a join public.parcelas pp on pp.acordo_id = a.id
                where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''),'\D','','g'),11,'0') and a.status = 'ATIVO'
                  and upper(coalesce(pp.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
                  and pp.vencimento < current_date - p_dias)
       or exists (select 1 from public.acordos_titulos t
                   where t.aluno_id = c.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
                     and lower(coalesce(t.status,'')) = 'em_aberto' and t.acordo_id is null
                     and t.vencimento < current_date - p_dias)
     );

  if not exists (select 1 from _eleg) then
    return jsonb_build_object('dias', p_dias, 'elegiveis', 0, 'movidos', 0,
                              'mensagem', 'Nada vencido além de ' || p_dias || ' dias na base da gestão.');
  end if;

  create temp table _op on commit drop as
  select u.email, u.nome,
         (select count(*) from public.acordos a
            join public.casos c2 on lpad(regexp_replace(coalesce(c2.cpf_limpo,''),'\D','','g'),11,'0') = a.cpf
           where a.status = 'ATIVO' and c2.operador_email = u.email)::int carga_acordo,
         (select count(*) from public.casos c3
            join public.calibragem_saldo_aluno s3 on s3.aluno_id = c3.aluno_id
           where c3.operador_email = u.email and coalesce(s3.saldo_total,0) > 0
             and not public.caso_encerrado_operacional(c3.cpf_limpo, c3.status_atual, c3.status_acionamento, c3.status_financeiro, c3.status_jornada)
             and not public.caso_protegido_redistribuicao(c3.cpf_limpo, c3.status_acionamento, c3.nao_acionar,
                   c3.status_financeiro, c3.valor_pago, c3.quitado_em, c3.valor_quitado))::int carga_caso
    from public.usuarios u
   where u.ativo and u.perfil = 'operador' and coalesce(u.recebe_novos_casos, true) and not (u.email = any(p_origens));
  if not exists (select 1 from _op) then
    raise exception 'Nenhum operador ativo para receber o nivelamento.';
  end if;

  alter table _eleg add column para_email text, add column para_nome text;

  create temp table _fila on commit drop as
    select caso_id, tem_acordo from _eleg order by tem_acordo desc, valor desc, caso_id;

  for v_caso in select * from _fila loop
    if v_caso.tem_acordo then
      select * into v_dest from _op order by carga_acordo asc, carga_caso asc, email limit 1;
      update _op set carga_acordo = carga_acordo + 1, carga_caso = carga_caso + 1 where email = v_dest.email;
    else
      select * into v_dest from _op order by carga_caso asc, carga_acordo asc, email limit 1;
      update _op set carga_caso = carga_caso + 1 where email = v_dest.email;
    end if;
    update _eleg set para_email = v_dest.email, para_nome = v_dest.nome where caso_id = v_caso.caso_id;
  end loop;

  if p_aplicar then
    perform set_config('calibragem.bypass_teto', 'on', true);
    update public.casos c
       set operador_email = e.para_email, operador_nome = e.para_nome, operador = upper(coalesce(e.para_nome,''))
      from _eleg e where c.id = e.caso_id and e.para_email is not null;
    get diagnostics v_movidos = row_count;

    insert into public.historico_operadores_alunos(aluno_id, chave_unificacao, nome_aluno, cpf_referencia, acao,
      operador_nome, operador_email, operador_anterior_email, observacao, criado_em)
    select e.aluno_id, e.chave_unificacao, e.nome, e.cpf, 'NIVELAMENTO_AUTOMATICO_GESTAO',
      e.para_nome, e.para_email, e.de_email,
      'Débito vencido há mais de ' || p_dias || ' dias na base da gestão: distribuído automaticamente para quem tinha menos.',
      now()
    from _eleg e where e.para_email is not null;
  end if;

  select jsonb_build_object(
    'dias', p_dias, 'aplicado', p_aplicar,
    'elegiveis', (select count(*) from _eleg),
    'movidos', v_movidos,
    'com_acordo', (select count(*) from _eleg where tem_acordo),
    'so_mensalidade', (select count(*) from _eleg where not tem_acordo),
    'valor', (select round(sum(valor),2) from _eleg),
    'destino', (select coalesce(jsonb_agg(jsonb_build_object('operador', para_nome, 'casos', q, 'valor', v) order by q desc),'[]')
                  from (select para_nome, count(*) q, round(sum(valor),2) v from _eleg where para_email is not null group by para_nome) t),
    'carga_depois', (select coalesce(jsonb_agg(jsonb_build_object('operador', nome, 'acordos', carga_acordo, 'casos', carga_caso) order by carga_acordo desc),'[]') from _op)
  ) into v_res;
  return v_res;
end;
$function$;
