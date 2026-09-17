-- ROLLBACK de 20260917210000_encerrar_pendencia_de_conciliacao.
-- Recria os tres corpos EXATOS de producao de 17/09/2026 e remove as tres
-- funcoes novas. Nao reabre pendencia ja encerrada (isso e decisao registrada,
-- com auditoria) e deixa a linha de fluxo_pagamentos_config -- sem funcao, a
-- etapa nao roda.
--   fluxo_pagamentos_rodar   418c15291cf912516d7f02304b4fdd2d
--   conciliacao_encerrar     e41a43f4bfe1754c45570f3afd5e2ade
--   pagamentos_sem_aluno     067e2b74c3f8ef3d52b60e42b8d5b93d

-- ---------------------------------------------------------------------------
-- fluxo_pagamentos_rodar (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio', public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    -- parcela paga antes da extracao, em acordo que ja entrou (17/09/2026)
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='reconstruir_parcela_paga_antes';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('reconstruir_parcela_paga_antes', public.parcela_paga_antes_reconstruir_pendentes(50));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;

    -- O acordo diz de onde veio. Por ultimo: nao altera as etapas acima.
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='vinculo_por_negociacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('vinculo_por_negociacao', public.prime_vincular_por_negociacao(true, 3));
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
    'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- conciliacao_encerrar (producao 17/09/2026)
-- ---------------------------------------------------------------------------
create or replace function public.conciliacao_encerrar(
  p_pagamento_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_email text; v_n int := 0; v_st text;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerrar pendencia de conciliacao e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select status_conciliacao into v_st from public.pagamentos where id = p_pagamento_id;
  if v_st is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_CONCILIACAO');
  end if;
  if v_st = 'BAIXADO' then
    return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO');
  end if;

  -- SO PARCELA_JA_PAGA. Uma `decisao` na fila faz o reprocessador parar de
  -- olhar aquele pagamento -- encerrar um AGUARDANDO_ACORDO, um
  -- AGUARDANDO_AMARRACAO, um REVISAO ou um SEM_VINCULO tiraria do motor
  -- exatamente o caso que ele ainda resolveria sozinho quando o acordo
  -- entrasse ou o boleto fosse amarrado. Esses continuam na fila ate serem
  -- resolvidos de verdade.
  if v_st <> 'PARCELA_JA_PAGA' then
    return jsonb_build_object('ok', false, 'motivo', 'SO_PARCELA_JA_PAGA',
      'status_conciliacao', v_st,
      'explicacao', 'encerrar este estado tiraria o pagamento do reprocessamento automatico');
  end if;

  update public.fila_pagamento_sem_vinculo
     set decisao = 'ENCERRADO_GESTAO',
         decidido_por = v_email,
         decidido_em = now(),
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'encerrado pela gestao'
           || case when p_observacao is null then '' else ': ' || p_observacao end
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'status_conciliacao', v_st, 'fila_fechada', v_n);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- pagamentos_sem_aluno (producao 17/09/2026)
-- ---------------------------------------------------------------------------
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
  motivo_financeiro text,
  sugestoes jsonb,
  detectado_em timestamptz,
  importacao_id uuid,
  arquivo_nome text,
  status_conciliacao text,
  tem_aluno boolean
)
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
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
    case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end::text,
    coalesce(c.qtd, 0)::int,
    -- Preferir o motivo da conciliacao, que e o novo e o mais especifico;
    -- cair para o motivo da fila; e so entao dizer que a linha e anterior.
    coalesce(p.conciliacao_motivo, f.motivo,
             'entrou antes da regra de identificador financeiro (12/09/2026)')::text,
    coalesce(f.sugestoes, '[]'::jsonb),
    f.detectado_em,
    p.importacao_id,
    i.arquivo_nome,
    p.status_conciliacao,
    (p.aluno_id is not null)
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
  where (p.aluno_id is null or f.pagamento_id is not null)
    and (coalesce(p_todos_os_meses, false)
         or to_char(p.data_pagamento, 'YYYY-MM') = mes.m)
  order by p.data_pagamento desc, p.valor_pago desc;
end;
$fn$;

drop function if exists public.conciliacao_ja_paga_encerrar_pendentes(integer);
drop function if exists public.conciliacao_ja_paga_encerrar(uuid, boolean);
drop function if exists public.conciliacao_ja_paga_previa(uuid);
