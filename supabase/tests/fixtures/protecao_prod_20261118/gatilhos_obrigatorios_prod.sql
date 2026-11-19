-- GATILHOS OBRIGATORIOS (producao, 2026-11-18): encerramento, reposicao, relogio da fidelizacao e recalculo de acordo.
-- Funcoes do fecho de dependencias (fecho_gatilhos_prod.json), definicoes de producao. Carregadas com check_function_bodies off.
set check_function_bodies = off;

-- public._acordo_status_reavalia_titulos() · md5(prosrc) da92e1a790d17f41e4e28e96e8a86fe0 · owner postgres
CREATE OR REPLACE FUNCTION public._acordo_status_reavalia_titulos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_titulo uuid;
begin
  for v_titulo in
    select distinct t.id from public.acordos_titulos t
     where t.acordo_id = new.id
    union
    select distinct v.titulo_id from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return null;
end;
$function$;

-- public._caso_encerrado_operacional_regra(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) 9472634d1c8adde3a5906fbaebbb8486 · owner postgres
CREATE OR REPLACE FUNCTION public._caso_encerrado_operacional_regra(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                       'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                       'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                       'SALDO ZERO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;

  if public._encerramento_congelado(p_aluno_id, p_caso_id, p_cpf, nat, nac, nfi, njo) then return true; end if;

  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit))
     and public._caso_sem_saldo_conferido(p_aluno_id, p_cpf) then return true; end if;

  return false;
end;
$function$;

-- public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text) · md5(prosrc) d72413941a1fc042a46af618239462ed · owner postgres
CREATE OR REPLACE FUNCTION public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cpf  text := public._cpf11(p_cpf);
  v_aid  uuid := p_aluno_id;
  v_n    int;
begin
  if v_aid is null then
    if v_cpf is null then
      return false;
    end if;
    select count(*) into v_n
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;
    if coalesce(v_n,0) <> 1 then
      return false;
    end if;
    select al.id into v_aid
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
     limit 1;
  end if;
  return coalesce((public.aluno_saldo_pendente_detalhe(v_aid)->>'total')::numeric, -1) <= 0.005;
end;
$function$;

-- public._cpf11(p_cpf text) · md5(prosrc) 09e6a3d7df4915eb9cbb20b8d97445e6 · owner postgres
CREATE OR REPLACE FUNCTION public._cpf11(p_cpf text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0'), '00000000000');
$function$;

-- public._encerramento_congelado(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_nat text, p_nac text, p_nfi text, p_njo text) · md5(prosrc) 8d3f4963997789ad94f28d571d310fb9 · owner postgres
CREATE OR REPLACE FUNCTION public._encerramento_congelado(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_nat text DEFAULT NULL::text, p_nac text DEFAULT NULL::text, p_nfi text DEFAULT NULL::text, p_njo text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.caso_encerramento_sem_saldo e
     where e.resolvido_em is null
       and (
         e.caso_id = p_caso_id
         or (p_caso_id is null and e.escopo = 'ALUNO' and e.aluno_id = p_aluno_id)
         or (e.cpf_congelado is not null
             and e.cpf_congelado = public._cpf11(p_cpf)
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_atual','')) = coalesce(p_nat,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_acionamento','')) = coalesce(p_nac,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_jornada','')) = coalesce(p_njo,'')
             and (e.escopo = 'ALUNO'
                  or public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_financeiro','')) = coalesce(p_nfi,'')))));
$function$;

-- public._encerramento_so_gestao() · md5(prosrc) ae0382adc0eaf11fbe68d9ed0fc4a9b4 · owner postgres
CREATE OR REPLACE FUNCTION public._encerramento_so_gestao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- PISO LITERAL -- nunca encolhe (ver FAIL-CLOSED no cabeçalho).
  -- + ANTECIPACAO_SEMESTRE (07/10/2026): passou a quitar parcela, virou
  --   decisao de gestao como cancelamento, suspensao e juridico.
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO','ANTECIPACAO_SEMESTRE','ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO'];
  v_catalogo text[];
  v_bloqueadas text[];
  v_tentou text;
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  -- Catalogo: aqui dentro a RLS de `tabulacoes` nao filtra (SECURITY DEFINER,
  -- dona postgres, tabela sem FORCE ROW LEVEL SECURITY), entao `somente_gestao`
  -- e legivel por inteiro. `coalesce` para array vazio: leitura vazia nao pode
  -- virar NULL e anular o `&&` do piso.
  select coalesce(array_agg(upper(btrim(codigo))), '{}'::text[])
    into v_catalogo
    from public.tabulacoes
   where somente_gestao;

  -- UNIAO piso + catalogo. A regua so cresce.
  select coalesce(array_agg(distinct c), '{}'::text[])
    into v_bloqueadas
    from unnest(v_encerra || v_catalogo) as c
   where c <> '';

  -- POR COLUNA E POR CODIGO -- NUNCA por sobreposicao de conjuntos.
  --
  -- O gatilho original perguntava `(v_novo && v_bloqueadas) and not (v_antigo
  -- && v_bloqueadas)`, com arrays das tres colunas. `&&` e SOBREPOSICAO: bastava
  -- o aluno JA carregar qualquer codigo bloqueado, em qualquer das tres
  -- colunas, para o portao ser pulado para QUALQUER codigo novo -- inclusive um
  -- diferente. Enquanto a lista eram so os 7 estados TERMINAIS, a brecha era
  -- estreita. Ao acrescentar o catalogo ela deixaria de ser: `RETORNO_FINANCEIRO`
  -- e neutro e NAO terminal, a gestao vai carimba-lo na rotina em casos que
  -- seguem na carteira do operador -- e "aluno com retorno do financeiro"
  -- viraria a chave que destranca cancelamento, suspensao e juridico para o
  -- operador. Com efeito financeiro: `trg_tabulacao_efeito_financeiro` e AFTER
  -- UPDATE OF status_jornada, nao tem portao proprio (conferido em producao em
  -- 06/11/2026) e chama `parcela_efeito_sem_pagamento_aplicar`.
  --
  -- A pergunta certa e por COLUNA: esta coluna esta RECEBENDO AGORA um codigo
  -- bloqueado que ela nao tinha? Isso preserva o que importava na regra antiga
  -- -- reescrever o que ja estava la passa, e por isso os 182 alunos de
  -- producao que carregam codigo so-gestao continuam editaveis pelo operador --
  -- e fecha a brecha.
  --
  -- MAIS ESTRITO QUE ANTES EM DOIS PONTOS, declarados de propósito:
  --   1. trocar um codigo bloqueado por OUTRO (ex.: suspensao -> juridico)
  --      passa a ser barrado para quem nao e gestao;
  --   2. copiar um codigo bloqueado de uma coluna para outra tambem.
  -- Medido em producao em 06/11/2026: existem 8 transicoes entre codigos
  -- bloqueados no historico (`aluno_movimentacoes`), e TODAS AS 8 foram feitas
  -- pela gestao -- que passa pelo bypass acima. Logo nenhum fluxo real de
  -- operador e interrompido por este endurecimento.
  -- `btrim` NOS DOIS LADOS. `v_bloqueadas` normaliza com `upper(btrim(codigo))`;
  -- se aqui fosse só `upper()`, 'CANCELAMENTO_COBRANCA ' com espaco passaria o
  -- portao. No servidor o valor ficaria inerte (os consumidores comparam por
  -- igualdade exata), mas `casoNoKpi` em src/components/PainelCarteira.jsx
  -- classifica concatenando os status e olhando SUBSTRING -- o valor com espaco
  -- apareceria como encerrado na tela. Simetria e mais barata que a duvida.
  select x.novo into v_tentou
    from (values
            (upper(btrim(coalesce(new.status_atual,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_atual,''))) end),
            (upper(btrim(coalesce(new.status_jornada,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_jornada,''))) end),
            (upper(btrim(coalesce(new.status_acionamento,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_acionamento,''))) end)
         ) as x(novo, antigo)
   where x.novo <> x.antigo
     and x.novo = any(v_bloqueadas)
   limit 1;

  if v_tentou is not null then
    if v_tentou = any(v_encerra) then
      -- Mensagem HISTORICA, palavra por palavra: os operadores a conhecem e
      -- ha teste ancorado nela.
      raise exception
        'Encerrar cobrança (cancelamento, suspensão, jurídico ou antecipação de semestre) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
        using errcode = '42501';
    else
      -- Tabulacao so-gestao que NAO encerra cobranca (ex.: RETORNO_FINANCEIRO).
      -- Dizer "encerrar cobranca" aqui seria mentir para o operador.
      raise exception
        'A tabulação "%" é restrita à gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.', v_tentou
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

-- public._fila_acordo_fecha_ao_encerrar_acordo() · md5(prosrc) 0268e4752dc8adbcd09d6cd3b24bf6bb · owner postgres
CREATE OR REPLACE FUNCTION public._fila_acordo_fecha_ao_encerrar_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- So interessa quando o acordo DEIXA de ser ativo.
  if upper(coalesce(new.status,'')) = 'ATIVO' or upper(coalesce(old.status,'')) <> 'ATIVO' then
    return null;
  end if;
  if new.aluno_id is null then
    return null;
  end if;

  update public.fila_acordos_confirmar f
     set status_confirmacao = 'ENCERRADO_SEM_ACORDO_ATIVO',
         confirmado_em = coalesce(f.confirmado_em, now()),
         observacao = coalesce(nullif(btrim(f.observacao),''),
           'Fechada automaticamente: o acordo correspondente foi encerrado. Nao ha o que confirmar.')
   where f.confirmado_em is null
     and coalesce(f.status_confirmacao,'A_CONFIRMAR') = 'A_CONFIRMAR'
     and (
       f.acordo_id = new.id
       or (f.acordo_id is null
           and f.aluno_id = new.aluno_id
           and round(coalesce(f.valor_total,0),2) = round(coalesce(new.valor_total,0),2))
     )
     -- Guarda: se ainda existe acordo ATIVO com esse valor, ha o que confirmar.
     and not exists (
       select 1 from public.acordos a
        where a.aluno_id = new.aluno_id
          and a.status = 'ATIVO'
          and round(coalesce(a.valor_total,0),2) = round(coalesce(f.valor_total,0),2)
     );

  return null;
end;
$function$;

-- public._titulo_quita_com_o_acordo() · md5(prosrc) 88ae3301ecc60692ffa5084dd900da1a · owner postgres
CREATE OR REPLACE FUNCTION public._titulo_quita_com_o_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(new.status,'')) <> 'QUITADO'
     or upper(coalesce(old.status,'')) = 'QUITADO' then
    return new;
  end if;

  -- Delega ao motor (01/10/2026). A guarda que existia aqui conferia parcela viva
  -- excluindo so ('PAGO','CANCELADA') -- deixava RENEGOCIADA contar como parcela
  -- viva, mais restritiva que o motor -- e nao gravava proveniencia nem o par de
  -- colunas. Perde-se o filtro de tipo_boleto='Acordo' que existia aqui, e isso
  -- NAO muda nada na pratica: o terceiro gatilho ja chamava o motor, que nao tem
  -- essa guarda. Elo pela COLUNA; o vinculo e coberto pelo outro gatilho.
  perform public.titulo_reavaliar(t.id)
    from public.acordos_titulos t
   where t.acordo_id = new.id;

  return new;
end;
$function$;

-- public._trg_recalc_por_aluno_uuid() · md5(prosrc) 58250d1bf0ecf1b1105b3c8b32a6e8f1 · owner postgres
CREATE OR REPLACE FUNCTION public._trg_recalc_por_aluno_uuid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_aluno uuid;
begin
  begin
    v_aluno := coalesce(NEW.aluno_id, OLD.aluno_id);
    if v_aluno is not null then perform public.recalcular_situacao_aluno(v_aluno, TG_ARGV[0]); end if;
  exception when others then null;
  end;
  return null;
end; $function$;

-- public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid) · md5(prosrc) 1f676604ebeba3561eafc6306e187ba2 · owner postgres
CREATE OR REPLACE FUNCTION public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar_confirmacao_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_titulos_abertos numeric := 0;
  v_titulos_orfaos  numeric := 0;
  v_parcelas_valor  numeric := 0;
  v_parcelas_qtd    int := 0;
  v_conf_pendentes  int := 0;
  v_tit_conf       int := 0;
  v_total           numeric := 0;
  v_req_claims text := current_setting('request.jwt.claims', true);
  v_role       text := lower(coalesce(auth.jwt() ->> 'role', ''));
  v_uid        uuid := auth.uid();
  v_interno    boolean;
begin
  v_interno := (v_req_claims is null) or (v_role = 'service_role');
  if not v_interno then
    if v_uid is null or v_role = 'anon' then
      raise exception 'Acesso negado.' using errcode = '42501';
    end if;
  end if;

  -- Mensalidade sai da conta SO quando vinculada a um acordo nao cancelado.
  -- Nada de deducao por data.
  select
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'ABERTO'), 0),
    coalesce(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
             filter (where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'), 0)
    into v_titulos_abertos, v_titulos_orfaos
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
     and coalesce(lower(t.status),'') not in ('quitada')
    -- Amanda, 01/09: "elas nao podem contabilizar no saldo de carteira".
    -- A divida do acordo sao as PARCELAS dele; o titulo do acordo e so o
    -- numero do boleto. Contar os dois e cobrar duas vezes.
    and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*), coalesce(sum(coalesce(p.valor,0)),0)
    into v_parcelas_qtd, v_parcelas_valor
    from public.parcelas p
    join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = p_aluno_id
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     and public.parcela_viva(p.status);

  select count(*)
    into v_conf_pendentes
    from public.solicitacoes_confirmacao_pagamento s
   where s.aluno_id = p_aluno_id::text
     and s.status = 'AGUARDANDO_CONFIRMACAO'
     and (p_ignorar_confirmacao_id is null or s.id <> p_ignorar_confirmacao_id);

  -- Titulo aguardando a Conferencia Prime: fora do total exigivel (nao e
  -- cobrado), mas e pendencia -- ninguem quita nem encerra o aluno por ele.
  select count(*)
    into v_tit_conf
    from public.acordos_titulos t
   where t.aluno_id = p_aluno_id
     and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO';

  v_total := v_titulos_abertos + v_titulos_orfaos + v_parcelas_valor;

  return jsonb_build_object(
    'aluno_id', p_aluno_id,
    'titulos_abertos', round(v_titulos_abertos, 2),
    'titulos_negociados_orfaos', round(v_titulos_orfaos, 2),
    -- Mantidos por compatibilidade; a deducao por data nao existe mais.
    'titulos_superados_valor', 0,
    'titulos_superados_qtd', 0,
    'parcelas_abertas_qtd', v_parcelas_qtd,
    'parcelas_abertas_valor', round(v_parcelas_valor, 2),
    'confirmacoes_pendentes', v_conf_pendentes,
    'confirmacao_ignorada', p_ignorar_confirmacao_id,
    'total', round(v_total, 2),
    'titulos_em_confirmacao', v_tit_conf,
    'tem_pendencia', (v_total > 0.005 or v_conf_pendentes > 0 or v_tit_conf > 0)
  );
end;
$function$;

-- public.calibragem_nivel_criticidade(p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric, p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb) · md5(prosrc) b0e1c029d9c35701d8caf60a0be854de · owner postgres
CREATE OR REPLACE FUNCTION public.calibragem_nivel_criticidade(p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric, p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  s numeric := 0;
  p jsonb := p_regras->'pesos';
  n jsonb := p_regras->'niveis';
  e jsonb := p_regras->'escada_dias';
  v_score  text;
  v_escada text := null;
  d int := coalesce(p_dias_sem_ac, 0);
begin
  if coalesce(p_dias_venc,0)   >= coalesce((p->'dias_vencido'->>'min')::int, 2147483647)        then s := s + coalesce((p->'dias_vencido'->>'peso')::numeric,0); end if;
  if coalesce(p_dias_sem_ac,0) >= coalesce((p->'dias_sem_acionamento'->>'min')::int, 2147483647) then s := s + coalesce((p->'dias_sem_acionamento'->>'peso')::numeric,0); end if;
  if coalesce(p_valor,0)       >= coalesce((p->'valor'->>'min')::numeric, 1e18)                   then s := s + coalesce((p->'valor'->>'peso')::numeric,0); end if;
  if coalesce(p_termo_pendente,false) then s := s + coalesce((p->'termo_pendente'->>'peso')::numeric,0); end if;
  if coalesce(p_fim_mes,false)        then s := s + coalesce((p->'fim_mes'->>'peso')::numeric,0); end if;

  -- ACIONAMENTO RECENTE: peso negativo. Sem a chave nas regras o `max` cai para
  -- -1 e isto nunca dispara -- a funcao segue identica a de antes.
  if coalesce(p_dias_sem_ac, 9999) <= coalesce((p->'acionado_recente'->>'max')::int, -1)
    then s := s + coalesce((p->'acionado_recente'->>'peso')::numeric,0); end if;

  if    s >= coalesce((n->>'critico')::numeric,5) then v_score := 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric,3) then v_score := 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric,1) then v_score := 'ATENCAO';
  else  v_score := 'NORMAL'; end if;

  -- ESCADA POR DIAS SEM ACIONAMENTO (Amanda, 02/09): "8 urgente, 9 critico,
  -- 10 perdendo caso". E PISO, nunca teto: o score ainda pode subir o nivel,
  -- nunca baixar. Sem a chave `escada_dias` nas regras, nada disto dispara e a
  -- funcao se comporta como antes.
  --
  -- O dia 10 fecha com a fidelizacao: `caso_dentro_prazo_fidelizacao` protege
  -- ate dua+10, e no 11o o caso pode ser retirado. "PERDENDO" e o aviso do
  -- ultimo dia em que ainda da para segurar.
  --
  -- Nunca acionado chega aqui como 9999 e cai em PERDENDO de proposito: a
  -- fidelizacao so comeca no 1o acionamento, entao esse caso nao esta protegido.
  if e is not null then
    if    d >= coalesce((e->>'perdendo')::int, 2147483647) then v_escada := 'PERDENDO';
    elsif d >= coalesce((e->>'critico')::int,  2147483647) then v_escada := 'CRITICO';
    elsif d >= coalesce((e->>'urgente')::int,  2147483647) then v_escada := 'URGENTE';
    end if;
  end if;

  if v_escada is null then return v_score; end if;
  return case when public.criticidade_rank(v_escada) > public.criticidade_rank(v_score)
              then v_escada else v_score end;
end;
$function$;

-- public.carteira_efetividade_invalidar(p_motivo text, p_origem text) · md5(prosrc) a85ed4882012a847a143d92942970539 · owner postgres
CREATE OR REPLACE FUNCTION public.carteira_efetividade_invalidar(p_motivo text DEFAULT NULL::text, p_origem text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, motivo, origem, pedidos)
  select r, now(), nullif(btrim(coalesce(p_motivo,'')), ''), nullif(btrim(coalesce(p_origem,'')), ''), 1
    from unnest(array['2024','2025','2026/1']) r
  on conflict (recorte) do update
     set invalidado_em = now(),
         motivo        = excluded.motivo,
         origem        = excluded.origem,
         pedidos       = public.carteira_efetividade_invalidacao.pedidos + 1;
end;
$function$;

-- public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid) · md5(prosrc) de84992ce76af33281ef09f8505bcfc3 · owner postgres
CREATE OR REPLACE FUNCTION public.caso_aguarda_confirmacao_financeira(p_aluno_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_aluno_id is not null
     and exists (select 1 from public.acordos_titulos t
                  where t.aluno_id = p_aluno_id
                    and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO')
     and coalesce((select sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))
                     from public.acordos_titulos t
                    where t.aluno_id = p_aluno_id
                      and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                      and coalesce(lower(t.status),'') <> 'quitada'
                      and coalesce(t.tipo_boleto,'') <> 'Acordo'
                      and not exists (select 1 from public.acordo_titulo_vinculo v
                                        join public.acordos a on a.id = v.acordo_id
                                       where v.titulo_id = t.id and coalesce(v.ativo, true)
                                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))), 0) <= 0.005
     and not exists (select 1 from public.parcelas p
                       join public.acordos a on a.id = p.acordo_id
                      where a.aluno_id = p_aluno_id
                        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
                        and public.parcela_viva(p.status));
$function$;

-- public.caso_encerrado_operacional(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) fddf04c759aba2bec730cc7da24ec68a · owner postgres
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_aluno_id uuid, p_caso_id uuid, p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    p_aluno_id, p_caso_id, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

-- public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text) · md5(prosrc) b65a36744bd71fe8837d59f378892944 · owner postgres
CREATE OR REPLACE FUNCTION public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._caso_encerrado_operacional_regra(
    null::uuid, null::uuid, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

-- public.caso_protegido_redistribuicao(p_cpf_limpo text, p_status_acionamento text, p_nao_acionar boolean, p_status_financeiro text, p_valor_pago numeric, p_quitado_em date, p_valor_quitado numeric) · md5(prosrc) 1c00d3fb6b87d3e1a3e2ab4efa6e59ed · owner postgres
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

-- public.casos_set_encerrado_operacional() · md5(prosrc) 6fd02f124e1b9e2ba8012c1b751406bb · owner postgres
CREATE OR REPLACE FUNCTION public.casos_set_encerrado_operacional()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.cpf_limpo         IS NOT DISTINCT FROM OLD.cpf_limpo
     AND NEW.status_atual      IS NOT DISTINCT FROM OLD.status_atual
     AND NEW.status_acionamento IS NOT DISTINCT FROM OLD.status_acionamento
     AND NEW.status_financeiro IS NOT DISTINCT FROM OLD.status_financeiro
     AND NEW.status_jornada    IS NOT DISTINCT FROM OLD.status_jornada THEN
    -- nada relevante mudou: preserva valor atual
    RETURN NEW;
  END IF;

  NEW.encerrado_operacional := public.caso_encerrado_operacional(
    NEW.cpf_limpo, NEW.status_atual, NEW.status_acionamento,
    NEW.status_financeiro, NEW.status_jornada);
  RETURN NEW;
END;
$function$;

-- public.criticidade_rank(p_nivel text) · md5(prosrc) 293b7b00d221a71d27dbfbf02ff90d25 · owner postgres
CREATE OR REPLACE FUNCTION public.criticidade_rank(p_nivel text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case upper(coalesce(p_nivel,''))
           when 'PERDENDO' then 4
           when 'CRITICO'  then 3
           when 'URGENTE'  then 2
           when 'ATENCAO'  then 1
           else 0
         end;
$function$;

-- public.dia_util_anterior_ou_igual(p_dia date) · md5(prosrc) 83ccb4aa0eab8251bebe3fa182b7f57d · owner postgres
CREATE OR REPLACE FUNCTION public.dia_util_anterior_ou_igual(p_dia date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case extract(isodow from p_dia)::int when 6 then p_dia - 1 when 7 then p_dia - 2 else p_dia end;
$function$;

-- public.fmt_brl(p numeric) · md5(prosrc) 3de38d5ddccb70976846c725b3e3ee76 · owner postgres
CREATE OR REPLACE FUNCTION public.fmt_brl(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$function$;

-- public.fn_sync_acionamento_alunos_para_casos() · md5(prosrc) ea3034d6bfc5b7b0dcd58f9c257efa8e · owner postgres
CREATE OR REPLACE FUNCTION public.fn_sync_acionamento_alunos_para_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dia date;
begin
  if new.data_ultimo_acionamento is not null
     and new.data_ultimo_acionamento is distinct from old.data_ultimo_acionamento then
    v_dia := (new.data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date;
    update public.casos c
       set data_ultimo_acionamento = v_dia
     where c.aluno_id = new.id
       and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < v_dia);
  end if;
  return new;
end; $function$;

-- public.normalizar_status_acionamento(p_status text) · md5(prosrc) 111639f9c4227e11b2f31fc7204ed64d · owner postgres
CREATE OR REPLACE FUNCTION public.normalizar_status_acionamento(p_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT trim(regexp_replace(
    upper(unaccent(coalesce(p_status, ''))),
    '[_\-]+', ' ', 'g'
  ));
$function$;

-- public.parcela_viva(p_status text) · md5(prosrc) df5e77b776af5f1360ac0f7d0ec500f2 · owner postgres
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

-- public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text) · md5(prosrc) 41475103b8b7ad363dfdc76c4170c5a8 · owner postgres
CREATE OR REPLACE FUNCTION public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text DEFAULT NULL::text)
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
    and public.parcela_viva(p.status);

  select p.vencimento, p.valor into v_prox_venc, v_prox_val
  from public.parcelas p
  join public.acordos a on a.id=p.acordo_id
  where a.aluno_id=p_aluno_id
    and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO')
    and public.parcela_viva(p.status)
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

  select coalesce((upper(btrim(coalesce(c.status_termo,''))) not in ('', 'SEM TERMO') and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')), false)
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

-- public.saldo_titulos_aberto(p_cpf text) · md5(prosrc) ee0d3a1f54b4785e57e0abd86157342f · owner postgres
CREATE OR REPLACE FUNCTION public.saldo_titulos_aberto(p_cpf text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(t.saldo_corrigido),0)
  from public.acordos_titulos t
  where t.cpf = lpad(regexp_replace(coalesce(p_cpf,''),'\D','','g'),11,'0')
    and coalesce(upper(t.situacao),'') = 'ABERTO'
    and coalesce(lower(t.status),'') <> 'quitada'
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);
$function$;

-- public.tg_acordo_alerta_resolve_acordo() · md5(prosrc) e3d8a4d8b204aa573109d92acc4cba54 · owner postgres
CREATE OR REPLACE FUNCTION public.tg_acordo_alerta_resolve_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    update public.acordo_alertas_parcela set resolvido_em = now(),
           resolucao = case when upper(coalesce(new.status,'')) = 'QUITADO' then 'ACORDO_QUITADO' else 'ACORDO_CANCELADO' end
     where acordo_id = new.id and resolvido_em is null;
  exception when others then
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ALERTA_D2_RESOLVE_FALHOU', 'acordos', new.id, jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE));
    exception when others then null;
    end;
  end;
  return null;
end; $function$;

-- public.tg_carteira_efetividade_invalidar() · md5(prosrc) 828a819d479265e0c7863e117939da83 · owner postgres
CREATE OR REPLACE FUNCTION public.tg_carteira_efetividade_invalidar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    perform public.carteira_efetividade_invalidar(
      'alteracao em ' || tg_table_name, 'GATILHO_' || upper(tg_table_name));
  exception when others then
    raise warning 'invalidacao da Efetividade falhou em % (%); o cron das :40 assume.',
      tg_table_name, sqlerrm;
  end;
  return null;
end;
$function$;

-- public.tipo_fechamento_caso(p_cpf_limpo text, p_status_acionamento text, p_status_financeiro text, p_quitado_em date, p_valor_quitado numeric) · md5(prosrc) d422a11e42a477dad901f34a7b23ffa6 · owner postgres
CREATE OR REPLACE FUNCTION public.tipo_fechamento_caso(p_cpf_limpo text, p_status_acionamento text, p_status_financeiro text, p_quitado_em date, p_valor_quitado numeric)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status_norm text := public.normalizar_status_acionamento(p_status_acionamento);
  v_status_fin_norm text := public.normalizar_status_acionamento(p_status_financeiro);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf_limpo,''), '\D', '', 'g'), 11, '0');
BEGIN
  IF v_status_norm = 'QUITADO'
     OR v_status_fin_norm IN ('PAGO', 'QUITADO')
     OR p_quitado_em IS NOT NULL
     OR coalesce(p_valor_quitado, 0) > 0
  THEN
    RETURN 'QUITADO';
  END IF;

  IF v_cpf <> '' AND v_cpf <> '00000000000'
     AND EXISTS (SELECT 1 FROM public.acordos a WHERE a.cpf = v_cpf AND a.status = 'QUITADO')
  THEN
    RETURN 'QUITADO';
  END IF;

  RETURN 'OUTRO'; -- acordo parcelado ativo, negociação, proposta, termo etc.
END;
$function$;

-- public.titulo_reavaliar(p_titulo uuid) · md5(prosrc) a86ab9bf86267fbf4c273a916b072cb7 · owner postgres
CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) in ('cancelada','devolvido') then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/QUEBRADO/INATIVO) SO
  -- continua NEGOCIADA quando algum acordo da cadeia dela chegou a receber
  -- dinheiro (parcela PAGO ou baixa viva): ai a divida passou a ser o saldo
  -- residual DO ACORDO (re-acordo, 22/09/2026), e reabrir a mensalidade pelo
  -- valor cheio cobraria de novo o que ja entrou.
  --
  -- Acordo que caiu SEM NENHUM pagamento na cadeia -- cancelado por falta de
  -- pagamento, o unico que o botao "Cancelar acordo" da ficha aceita -- nao
  -- negociou nada de fato: a mensalidade desce para o caminho de baixo, volta
  -- para ABERTO e fica livre para um acordo novo (Amanda, 25/09/2026). O
  -- vinculo inativo continua na tabela: a composicao do acordo cancelado nao
  -- se perde.
  --
  -- A cadeia e todo acordo pelo qual a mensalidade passou (vinculos ativos ou
  -- nao, mais o acordo_id que o titulo guarda), nao so o ultimo: no re-acordo
  -- A (pago em parte) -> B (cancelado sem pagar), o dinheiro entrou em A.
  --
  -- So entra aqui quando a situacao ATUAL do titulo ja e NEGOCIADO: se nunca
  -- foi negociado, ou se o motivo de nao achar vinculo vivo e outro, o caminho
  -- de baixo decide, como sempre decidiu.
  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')
       and exists (
         select 1
           from (select v.acordo_id from public.acordo_titulo_vinculo v
                  where v.titulo_id = p_titulo
                 union
                 select v_acordo_atual) c
          where c.acordo_id is not null
            and (exists (select 1 from public.parcelas p
                          where p.acordo_id = c.acordo_id
                            and upper(coalesce(p.status,'')) = 'PAGO')
                 or exists (select 1 from public.baixas_pagamento b
                             where b.acordo_id = c.acordo_id
                               and b.devolvido_em is null))) then
      return;
    end if;
  end if;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA','DEVOLVIDA','SUSPENSA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           origem_liquidacao     = coalesce(origem_liquidacao, 'ACORDO_QUITADO'),
           origem_liquidacao_ref = coalesce(origem_liquidacao_ref, v_acordo::text),
           origem_liquidacao_em  = coalesce(origem_liquidacao_em, now()),
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

-- public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date) · md5(prosrc) c27797fc7a5471099303e90b157375fb · owner postgres
CREATE OR REPLACE FUNCTION public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Aposentada em 26/08/2026. A mensalidade so sai da conta quando VINCULADA
  -- a um acordo (acordo_titulo_vinculo). Nao existe deducao por data.
  select false;
$function$;

-- public.titulos_por_status_acordo() · md5(prosrc) eefc8ab7128c8cda0095270d8728a87b · owner postgres
CREATE OR REPLACE FUNCTION public.titulos_por_status_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'QUITADO' then
    -- NAO DECIDE MAIS NADA AQUI (01/10/2026). Ver o cabecalho desta versao: o
    -- update em bloco que existia aqui quitava mensalidade sem conferir parcela
    -- viva e foi a causa dos 491 titulos PAGO com acordo ATIVO (G2). Quem decide
    -- e titulo_reavaliar, que confere vinculo vivo, acordo QUITADO e ZERO parcela
    -- viva (RENEGOCIADA nao conta como viva), grava o PAR de colunas e a
    -- proveniencia ACORDO_QUITADO. Ele NAO confere tipo_boleto -- ver o cabecalho.
    perform public.titulo_reavaliar(v.titulo_id)
      from public.acordo_titulo_vinculo v
     where v.acordo_id = new.id and coalesce(v.ativo, true);

  elsif new.status = 'CANCELADO' then
    -- A MENSALIDADE NEGOCIADA NAO VOLTA A SER ABERTA AQUI (branch removida em
    -- 22/09/2026): cancelar o acordo muda o estado do ACORDO, nao desfaz
    -- retroativamente a negociacao das mensalidades originais. Quem decide o
    -- destino do titulo e titulo_reavaliar, chamado pelo outro gatilho desta
    -- mesma tabela (trg_acordo_status_reavalia_titulos) -- ele preserva
    -- NEGOCIADO quando o motivo e so o acordo ter caido.

    -- o BOLETO DO PROPRIO ACORDO morre junto com ele, tendo mensalidade
    -- vinculada ou nao. Ele nunca foi divida: e o numero do documento.
    update public.acordos_titulos t
       set situacao = 'CANCELADA',
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'boleto do proprio acordo, cancelado junto com o acordo em '
             || to_char(now(),'DD/MM/YYYY'),
           atualizado_em = now()
      from public.acordo_titulo_vinculo v
     where v.titulo_id = t.id and v.acordo_id = new.id and coalesce(v.ativo, true)
       and t.situacao in ('NEGOCIADO','ABERTO')
       and coalesce(t.tipo_boleto,'') = 'Acordo';
  end if;

  return new;
end;
$function$;

-- public.trg_repor_caso_operador() · md5(prosrc) 03477cc4d987923e8776c34ff2d72614 · owner postgres
CREATE OR REPLACE FUNCTION public.trg_repor_caso_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := NEW.operador_email;
  v_nome  text := NEW.operador_nome;
  v_tipo  text;
begin
  if v_email is null then
    return NEW;
  end if;

  if not exists (select 1 from public.usuarios u where u.email = v_email and u.perfil = 'operador' and u.ativo = true) then
    return NEW;
  end if;

  if public.caso_protegido_redistribuicao(OLD.cpf_limpo, OLD.status_acionamento, OLD.nao_acionar, OLD.status_financeiro, OLD.valor_pago, OLD.quitado_em, OLD.valor_quitado) then
    return NEW;
  end if;

  if not public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) then
    return NEW;
  end if;

  v_tipo := public.tipo_fechamento_caso(NEW.cpf_limpo, NEW.status_acionamento, NEW.status_financeiro, NEW.quitado_em, NEW.valor_quitado);

  update public.casos
     set operador_email = null, operador_nome = null, operador = null
   where id = NEW.id;

  insert into public.historico_operadores_alunos (
    chave_unificacao, nome_aluno, cpf_referencia, acao,
    operador_anterior_nome, operador_anterior_email, observacao, criado_em
  ) values (
    NEW.chave_unificacao, NEW.nome, NEW.cpf, 'LIBERACAO_AUTOMATICA_CASO_FECHADO',
    v_nome, v_email,
    'Caso fechado (' || v_tipo || ', status: ' || coalesce(NEW.status_acionamento,'-') || ') -- liberado automaticamente', now()
  );

  insert into public.reposicao_carteira_fila (operador_email, operador_nome, operador_upper, tipo, caso_origem_id)
  values (v_email, v_nome, NEW.operador, v_tipo, NEW.id);

  return NEW;
end;
$function$;

-- public.usuario_e_gestao() · md5(prosrc) 889cfa4a82e9046b4322e8c85ee07b7d · owner postgres
CREATE OR REPLACE FUNCTION public.usuario_e_gestao()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$;
set check_function_bodies = on;

-- tabela de reposicao: colunas usadas pelo gatilho de producao (insert). Reproduzida minima e declarada.
create table if not exists public.reposicao_carteira_fila (id uuid primary key default gen_random_uuid(), operador_email text, operador_nome text, operador_upper text, tipo text, caso_origem_id uuid, criado_em timestamptz not null default now());
create table if not exists public.retorno_acordo_auto (id uuid primary key default gen_random_uuid(), aluno_id uuid, proximo_vencimento date, data_retorno date, valor numeric, lote text, criado_em timestamptz default now());
create table if not exists public.carteira_efetividade_invalidacao (id uuid primary key default gen_random_uuid(), recorte text, invalidado_em timestamptz, motivo text, origem text, pedidos int);

drop trigger if exists trg_recalc_acordo on public.acordos;
CREATE TRIGGER trg_recalc_acordo AFTER INSERT OR UPDATE ON public.acordos FOR EACH ROW EXECUTE FUNCTION _trg_recalc_por_aluno_uuid('trg_acordo');

drop trigger if exists trg_encerramento_so_gestao on public.alunos;
CREATE TRIGGER trg_encerramento_so_gestao BEFORE UPDATE OF status_atual, status_jornada, status_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION _encerramento_so_gestao();

drop trigger if exists trg_sync_acionamento_alunos_para_casos on public.alunos;
CREATE TRIGGER trg_sync_acionamento_alunos_para_casos AFTER UPDATE OF data_ultimo_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION fn_sync_acionamento_alunos_para_casos();

drop trigger if exists trg_casos_set_encerrado_operacional on public.casos;
CREATE TRIGGER trg_casos_set_encerrado_operacional BEFORE INSERT OR UPDATE ON public.casos FOR EACH ROW EXECUTE FUNCTION casos_set_encerrado_operacional();

drop trigger if exists trigger_repor_caso_operador on public.casos;
CREATE TRIGGER trigger_repor_caso_operador AFTER UPDATE ON public.casos FOR EACH ROW WHEN (((new.operador_email IS NOT NULL) AND (new.operador_email = old.operador_email))) EXECUTE FUNCTION trg_repor_caso_operador();
