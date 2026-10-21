-- COMPLEMENTO DA BANCADA PARA A M3 -- corpos de PRODUÇÃO de 21/10/2026.
--
-- A base é `fidelizacao_por_dono_prod_20260930.sql`, que já monta as tabelas
-- (`casos`, `usuarios`, `acordos`, `parcelas`, `acordos_titulos`,
-- `acordo_titulo_vinculo`, `links_pagamento`, `baixas_pagamento`,
-- `solicitacoes_confirmacao_pagamento`, `historico_operadores_alunos`,
-- `calibragem_parametros`) e as funções `caso_dentro_prazo_fidelizacao`,
-- `caso_encerrado_operacional`, `caso_protegido_redistribuicao` e
-- `titulo_superado_por_acordo`.
--
-- O que a base NÃO tem, porque é de 30/09 e o giro nasceu em 16/10
-- (20261016115142): a coluna `casos.giro_fidelizacao_ate` e a função
-- `caso_em_giro_fidelizacao`. Mais `parcela_viva`, `calibragem_e_gestao`, a view
-- `calibragem_saldo_aluno` e a própria `nivelamento_automatico_gestao`.
--
-- Cada corpo abaixo é o EXATO de produção, e o teste confere um por um por
-- `md5(prosrc)` contra `nivelamento_m3_prod_20261021.md5.json`. Se alguma
-- transcrição estiver errada por um caractere, o teste falha -- não passa calado.
--
-- NENHUM DADO REAL: só estrutura e corpo de função. Os dados são criados pelo
-- teste, com CPF e nome sintéticos.

-- ---------------------------------------------------------------------------
-- O motor do patch ancorado, que a migration usa. Corpo de producao,
-- identico ao que a bancada da M1 (assumir_caso_livre_prod_20261020) ja usa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION internal.patch_funcao_ancorada(p_schema text, p_funcao text, p_ancora text, p_novo text, p_ocorrencias integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare v_src text; v_n int; v_ja int;
begin
  -- Patch ambiguo: se o texto novo e um PEDACO da ancora, ele ja aparece na
  -- funcao antes de qualquer troca e nao da para distinguir "ja aplicado" de
  -- "nunca aplicado". Recusa na entrada em vez de errar em silencio.
  if position(p_novo in p_ancora) > 0 and position(p_ancora in p_novo) = 0 then
    raise exception 'patch_funcao_ancorada: o texto novo e pedaco da ancora — patch ambiguo, reescreva a ancora.';
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_funcao
   limit 1;

  if v_src is null then
    raise exception 'patch_funcao_ancorada: %.% nao existe.', p_schema, p_funcao;
  end if;

  -- Idempotencia ANTES da contagem da ancora. Nos patches que so ACRESCENTAM
  -- (o texto novo contem a ancora), a ancora continua existindo depois de
  -- aplicado — entao contar ancora nao distingue nada. O que distingue e o
  -- texto NOVO ja estar la.
  v_ja := (length(v_src) - length(replace(v_src, p_novo, ''))) / length(p_novo);
  if v_ja >= p_ocorrencias then
    raise notice 'patch_funcao_ancorada: %.% ja estava aplicada.', p_schema, p_funcao;
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, p_ancora, ''))) / length(p_ancora);
  if v_n <> p_ocorrencias then
    raise exception 'patch_funcao_ancorada: %.% tem % ocorrencia(s) da ancora, esperado %. A funcao mudou; revise o patch.',
      p_schema, p_funcao, v_n, p_ocorrencias;
  end if;

  execute replace(v_src, p_ancora, p_novo);
end;
$function$;

-- ---------------------------------------------------------------------------
-- A marca do giro: coluna + índice parcial, como em 20261016115142.
-- ---------------------------------------------------------------------------
alter table public.casos add column if not exists giro_fidelizacao_ate date;
create index if not exists ix_casos_giro_fidelizacao_ate
  on public.casos (giro_fidelizacao_ate) where giro_fidelizacao_ate is not null;

-- ---------------------------------------------------------------------------
-- Compara em data LOCAL DE BRASÍLIA, não em current_date.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caso_em_giro_fidelizacao(p_ate date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_ate is not null
     and p_ate >= (now() at time zone 'America/Sao_Paulo')::date;
$function$;

CREATE OR REPLACE FUNCTION public.parcela_viva(p_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$function$;

CREATE OR REPLACE FUNCTION public.calibragem_e_gestao()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then return false; end if;
  if v_email in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then return true; end if;
  return false;
end; $function$;

-- ---------------------------------------------------------------------------
-- O saldo que o nivelamento usa para decidir elegibilidade e carga.
-- ---------------------------------------------------------------------------
create or replace view public.calibragem_saldo_aluno as
 WITH tit AS (
         SELECT t.aluno_id,
            t.cpf,
            sum(COALESCE(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0::numeric)) AS saldo_mensalidade,
            count(*) AS qtd_titulos_abertos,
            min(t.vencimento) AS venc_min,
            max(t.vencimento) AS venc_max
           FROM acordos_titulos t
          WHERE upper(COALESCE(t.situacao, ''::text)) = 'ABERTO'::text AND lower(COALESCE(t.status, ''::text)) = 'em_aberto'::text AND t.acordo_id IS NULL AND NOT (EXISTS ( SELECT 1
                   FROM acordo_titulo_vinculo v
                  WHERE v.titulo_id = t.id AND COALESCE(v.ativo, true))) AND NOT titulo_superado_por_acordo(t.aluno_id, t.vencimento)
          GROUP BY t.aluno_id, t.cpf
        ), par AS (
         SELECT a.aluno_id,
            sum(COALESCE(p.valor, 0::numeric)) AS saldo_acordo,
            count(*) AS qtd_parcelas_abertas
           FROM parcelas p
             JOIN acordos a ON a.id = p.acordo_id
          WHERE (lower(COALESCE(a.status, ''::text)) <> ALL (ARRAY['cancelado'::text, 'cancelada'::text])) AND (upper(COALESCE(p.status, ''::text)) <> ALL (ARRAY['PAGO'::text, 'PAGA'::text, 'CANCELADA'::text, 'CANCELADO'::text, 'ESTORNADA'::text, 'ESTORNADO'::text]))
          GROUP BY a.aluno_id
        )
 SELECT COALESCE(tit.aluno_id, par.aluno_id) AS aluno_id,
    tit.cpf,
    COALESCE(tit.saldo_mensalidade, 0::numeric) AS saldo_mensalidade,
    COALESCE(par.saldo_acordo, 0::numeric) AS saldo_acordo,
    COALESCE(tit.saldo_mensalidade, 0::numeric) + COALESCE(par.saldo_acordo, 0::numeric) AS saldo_total,
    COALESCE(tit.qtd_titulos_abertos, 0::bigint) AS qtd_titulos_abertos,
    COALESCE(par.qtd_parcelas_abertas, 0::bigint) AS qtd_parcelas_abertas,
    tit.venc_min,
    tit.venc_max
   FROM tit
     FULL JOIN par ON par.aluno_id = tit.aluno_id;

-- ---------------------------------------------------------------------------
-- O ALVO DA M3 -- corpo EXATO de produção em 21/10/2026, md5(prosrc)
-- f058f92912052301694ae481681e3975, 6.599 bytes, com `giro_fidelizacao_ate`
-- aparecendo ZERO vezes. É esse zero que a M3 corrige.
-- ---------------------------------------------------------------------------
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
     -- Fidelizacao de 10 dias: quem foi acionado ha 10 dias ou menos fica com
     -- o responsavel atual, mesmo que o debito esteja vencido ha mais tempo.
     and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
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
                  and public.parcela_viva(pp.status)
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
