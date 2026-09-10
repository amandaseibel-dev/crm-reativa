-- WHATSAPP, PRAZO DE ACIONAMENTO E SINAL DE PAGAMENTO DIVERGENTE (10/09/2026)
--
-- Versiona o que foi aplicado direto em producao no dia do giro de carteira:
--
-- WHATSAPP
--   whatsapp_canal_arquivar          -- aposenta um numero sem apagar historico
--   whatsapp_canais_listar           -- passa a esconder os arquivados
--   whatsapp_remetente_autorizado    -- quem pode falar por aquele numero
--   whatsapp_canal_remetentes_salvar -- define a lista (NULL/vazio = todos)
--   whatsapp_preparar_envio(_novo)   -- os dois portoes passam a checar a lista
--
-- PRAZO DE ACIONAMENTO
--   prazo_acionamento_base_vigente   -- le parametros_operacao
--   sistema_assumir_receptivo        -- dentro do prazo o receptivo atende mas
--                                       nao toma o caso de quem ainda nao acionou
--
-- CONFERENCIA
--   projecao_pagamentos_dono_divergente -- pagamento cujo credito, dono do caso
--                                          e ultimo acionamento nao batem
--
-- As tabelas/colunas de apoio (whatsapp_canais.arquivado_em,
-- whatsapp_canais.remetentes_autorizados e parametros_operacao) estao logo
-- abaixo; as funcoes vem na sequencia, no estado final aplicado.

alter table public.whatsapp_canais
  add column if not exists arquivado_em timestamptz,
  add column if not exists arquivado_por text,
  add column if not exists remetentes_autorizados text[];

create table if not exists public.parametros_operacao (
  chave       text primary key,
  valor       jsonb not null,
  descricao   text,
  atualizado_em    timestamptz not null default now(),
  atualizado_por   text
);
alter table public.parametros_operacao enable row level security;
drop policy if exists parametros_operacao_leitura on public.parametros_operacao;
create policy parametros_operacao_leitura on public.parametros_operacao
  for select to authenticated using (public.app_usuario_ativo());

insert into public.parametros_operacao (chave, valor, descricao, atualizado_por)
values ('prazo_acionamento_base', jsonb_build_object('ate', '2026-09-17'),
  'Ate esta data (inclusive) o receptivo nao toma caso de operador que ainda esta dentro do prazo de acionar a base nova.',
  'giro de carteira 10/09/2026')
on conflict (chave) do nothing;

CREATE OR REPLACE FUNCTION public.prazo_acionamento_base_vigente()
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (valor->>'ate')::date from public.parametros_operacao where chave='prazo_acionamento_base';
$function$
;

CREATE OR REPLACE FUNCTION public.projecao_pagamentos_dono_divergente(p_de date DEFAULT CURRENT_DATE, p_ate date DEFAULT CURRENT_DATE)
 RETURNS TABLE(pagamento_id uuid, data_pagamento date, aluno_nome text, cpf text, valor_pago numeric, creditado_para text, dono_do_caso text, ultimo_acionamento_por text, ultimo_acionamento_em date, dias_desde_acionamento integer, motivo text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select p.id, p.data_pagamento, coalesce(p.aluno_nome, c.nome, c.nome_aluno) aluno, p.cpf,
           p.valor_pago,
           p.operador_nome creditado,
           c.operador_nome dono,
           c.data_ultimo_acionamento,
           (select h.operador_anterior_nome
              from public.historico_operadores_alunos h
             where h.chave_unificacao = c.chave_unificacao
               and h.acao = 'ASSUMIU_ATENDIMENTO'
               and h.criado_em <= p.created_at
             order by h.criado_em desc limit 1) dono_antes
      from public.pagamentos p
      left join public.casos c on c.aluno_id = p.aluno_id
     where p.data_pagamento between p_de and p_ate
  )
  select id, data_pagamento, aluno, cpf, valor_pago,
         coalesce(creditado,'(sem operador)'),
         coalesce(dono,'(sem dono)'),
         coalesce(dono_antes,'—'),
         data_ultimo_acionamento,
         (current_date - data_ultimo_acionamento)::int,
         case
           when dono is null then 'Aluno pagou e não está com ninguém'
           when creditado is null then 'Pagamento sem operador creditado'
           when creditado is distinct from dono then 'Crédito para ' || creditado || ', caso está com ' || dono
           when dono_antes is not null and dono_antes is distinct from dono
             then 'Caso trocou de dono: era de ' || dono_antes
           else null
         end
    from base
   where dono is null
      or creditado is null
      or creditado is distinct from dono
      or (dono_antes is not null and dono_antes is distinct from dono)
   order by valor_pago desc;
$function$
;

CREATE OR REPLACE FUNCTION public.sistema_assumir_receptivo(p_aluno_id uuid, p_status text, p_observacao text, p_data_retorno date DEFAULT NULL::date, p_hora_retorno text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare v_email text; v_nome text; v_n int; v_dono text; v_dono_nome text;
        v_prazo date; v_al record;
begin
  v_email := lower(coalesce(auth.jwt()->>'email','')); if v_email='' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  v_nome := internal.nome_operador_ativo(v_email); if v_nome is null then return jsonb_build_object('ok',false,'erro','NAO_E_OPERADOR_ATIVO'); end if;
  if coalesce(btrim(p_observacao),'')='' then return jsonb_build_object('ok',false,'erro','OBSERVACAO_OBRIGATORIA'); end if;
  if public.caso_saldo_zerado_real(p_aluno_id, null) then
    perform internal.encaminhar_saldo_zerado_confirmacao(p_aluno_id);
    return jsonb_build_object('ok',false,'erro','SALDO_ZERADO',
      'mensagem','Este aluno esta sem saldo em aberto. Encaminhado para Confirmacao de Pagamentos; nao entra na carteira de cobranca.');
  end if;

  -- PRAZO DA BASE NOVA. Dentro do prazo, o aluno de outro operador continua
  -- dele: o receptivo atende e registra, mas nao leva o caso embora. Vale so
  -- para quem TEM dono e ainda NAO foi acionado -- caso ja acionado seguiu o
  -- fluxo normal e nao precisa desta protecao.
  v_prazo := public.prazo_acionamento_base_vigente();
  if v_prazo is not null and current_date <= v_prazo then
    select a.operador_email, a.operador_nome, a.data_ultimo_acionamento into v_al
      from public.alunos a where a.id = p_aluno_id;
    if v_al.operador_email is not null
       and lower(v_al.operador_email) <> v_email
       and v_al.data_ultimo_acionamento is null then
      return jsonb_build_object('ok', false, 'erro', 'DENTRO_DO_PRAZO_DO_DONO',
        'por', coalesce(v_al.operador_nome, v_al.operador_email),
        'prazo', to_char(v_prazo,'DD/MM'),
        'mensagem', 'Este aluno é de ' || coalesce(v_al.operador_nome, v_al.operador_email) ||
                    ', que tem até ' || to_char(v_prazo,'DD/MM') || ' para acionar a base nova. ' ||
                    'Você pode atender e registrar, mas o caso continua com ' ||
                    coalesce(v_al.operador_nome, 'o responsável') || ' até lá.');
    end if;
  end if;

  update public.alunos set operador_nome=v_nome, operador_email=v_email, operador=v_nome,
      status_jornada=p_status, status_atual=p_status, status_acionamento=p_status,
      data_retorno=p_data_retorno, hora_retorno=p_hora_retorno, observacao=p_observacao,
      retorno_origem = case when p_data_retorno is null then null else 'OPERADOR' end,
      origem='Base receptiva', tipo_base='RECEPTIVA', atualizado_em=now()
   where id=p_aluno_id
     and not (
          status_jornada = 'EM_ATENDIMENTO'
      and responsavel_atual_email is not null
      and lower(responsavel_atual_email) <> v_email
      and atualizado_em > now() - interval '2 hours'
     );
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select responsavel_atual_email, responsavel_atual_nome into v_dono, v_dono_nome
      from public.alunos where id=p_aluno_id;
    return jsonb_build_object('ok',false,'erro','JA_EM_ATENDIMENTO',
      'por', coalesce(v_dono_nome, v_dono, 'outro operador'),
      'mensagem','Este aluno ja esta em atendimento por '||coalesce(v_dono_nome, v_dono, 'outro operador')||'. Atualize a lista da base receptiva.');
  end if;

  perform internal.set_resp_aluno(p_aluno_id, v_email, v_nome, 'ASSUMIU_ATENDIMENTO', 'Assumiu pela Base Receptiva. Origem: assumir_receptivo.', v_email, v_nome);
  return jsonb_build_object('ok',true,'aluno_id',p_aluno_id);
end;$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_canais_listar(p_incluir_arquivados boolean DEFAULT false)
 RETURNS TABLE(id uuid, apelido text, display_phone_number text, sessao_chave text, ativo boolean, conexao_status text, conexao_detalhe text, conexao_atualizada_em timestamp with time zone, ultimo_heartbeat_em timestamp with time zone, online boolean, sync_inicial_em timestamp with time zone, aguardando_qr boolean, arquivado_em timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT k.id, k.apelido, k.display_phone_number, k.sessao_chave, k.ativo,
         k.conexao_status, k.conexao_detalhe, k.conexao_atualizada_em,
         k.ultimo_heartbeat_em,
         (k.conexao_status = 'CONECTADO'
          AND k.ultimo_heartbeat_em IS NOT NULL
          AND k.ultimo_heartbeat_em > now() - make_interval(
                mins => (SELECT minutos_sem_heartbeat_alerta FROM public.whatsapp_config WHERE id))
         ) AS online,
         k.sync_inicial_em,
         (k.conexao_status = 'AGUARDANDO_QR' AND k.qr_expira_em > now()) AS aguardando_qr,
         k.arquivado_em
  FROM public.whatsapp_canais k
  WHERE public.app_usuario_ativo()
    AND (p_incluir_arquivados OR k.arquivado_em IS NULL)
  ORDER BY k.apelido;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_canal_arquivar(p_canal_id uuid, p_arquivar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := coalesce(auth.jwt() ->> 'email', 'server'); v_c record;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para arquivar canal de WhatsApp.';
  end if;
  select * into v_c from public.whatsapp_canais where id = p_canal_id;
  if not found then raise exception 'Canal não encontrado.'; end if;

  -- Canal conectado nao se arquiva por engano: teria que ser desconectado antes.
  if p_arquivar and v_c.conexao_status = 'CONECTADO' then
    raise exception 'O canal % está conectado. Desconecte antes de arquivar.', v_c.apelido;
  end if;

  update public.whatsapp_canais
     set arquivado_em = case when p_arquivar then now() else null end,
         arquivado_por = case when p_arquivar then v_email else null end,
         ativo = case when p_arquivar then false else ativo end
   where id = p_canal_id;

  insert into public.whatsapp_conexao_eventos (canal_id, sessao_chave, evento, detalhe, por_email)
  values (p_canal_id, v_c.sessao_chave,
          case when p_arquivar then 'CANAL_ARQUIVADO' else 'CANAL_DESARQUIVADO' end,
          case when p_arquivar then 'Canal aposentado: sai da Central; conversas e mensagens ficam guardadas.'
               else 'Canal devolvido à operação.' end,
          v_email);

  return jsonb_build_object('canal', v_c.apelido, 'arquivado', p_arquivar);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_canal_remetentes_salvar(p_canal_id uuid, p_emails text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_c record;
begin
  if not (public.usuario_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para definir quem envia por este canal.';
  end if;
  select * into v_c from public.whatsapp_canais where id = p_canal_id;
  if not found then raise exception 'Canal não encontrado.'; end if;

  update public.whatsapp_canais
     set remetentes_autorizados = case when p_emails is null or cardinality(p_emails)=0
                                       then null else p_emails end
   where id = p_canal_id;

  insert into public.whatsapp_conexao_eventos (canal_id, sessao_chave, evento, detalhe, por_email)
  values (p_canal_id, v_c.sessao_chave, 'REMETENTES_DEFINIDOS',
          coalesce(array_to_string(p_emails, ', '), 'todos os usuários ativos'),
          coalesce(auth.jwt() ->> 'email','server'));

  return jsonb_build_object('canal', v_c.apelido, 'remetentes', coalesce(p_emails, array['(todos)']));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio(p_conversa_id uuid)
 RETURNS TABLE(sessao_chave text, telefone_e164 text, operador_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conv  public.whatsapp_conversas%ROWTYPE;
  v_canal public.whatsapp_canais%ROWTYPE;
  v_email text := public.app_email();
  v_nome  text;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.whatsapp_conversas WHERE id = p_conversa_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversa inexistente'; END IF;

  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = v_conv.canal_id;
  IF NOT FOUND OR NOT v_canal.ativo THEN RAISE EXCEPTION 'canal inativo'; END IF;

  IF v_canal.conexao_status <> 'CONECTADO' THEN
    RAISE EXCEPTION 'numero % esta % - reconecte antes de responder',
      v_canal.apelido, v_canal.conexao_status USING ERRCODE = '42501';
  END IF;

  IF NOT public.whatsapp_remetente_autorizado(v_canal.id, v_email) THEN
    RAISE EXCEPTION 'o numero % e restrito: seu usuario nao envia por ele', v_canal.apelido
      USING ERRCODE = '42501';
  END IF;

  IF v_conv.responsavel_email IS NOT NULL
     AND v_conv.responsavel_email <> v_email
     AND NOT public.usuario_e_gestao() THEN
    RAISE EXCEPTION 'conversa em atendimento por %', v_conv.responsavel_email
      USING ERRCODE = '42501';
  END IF;

  -- CADENCIA. Vem DEPOIS das travas de acesso e ANTES de assumir a conversa:
  -- envio barrado nao pode deixar o operador marcado como responsavel de uma
  -- conversa que ele nao conseguiu atender.
  PERFORM public.whatsapp_cadencia_checar(v_conv.canal_id, p_conversa_id, v_email);

  IF v_conv.responsavel_email IS NULL THEN
    SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;
    UPDATE public.whatsapp_conversas
    SET responsavel_email = v_email,
        responsavel_nome  = coalesce(v_nome, v_email),
        responsavel_desde = now(),
        status            = 'EM_ATENDIMENTO',
        atualizado_em     = now()
    WHERE id = p_conversa_id;
  END IF;

  RETURN QUERY SELECT v_canal.sessao_chave, v_conv.telefone_e164, v_email;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_preparar_envio_novo(p_canal_id uuid, p_telefone text, p_aluno_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(conversa_id uuid, sessao_chave text, telefone_e164 text, operador_email text, ja_existia boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_canal public.whatsapp_canais%ROWTYPE;
  v_conv  public.whatsapp_conversas%ROWTYPE;
  v_email text := public.app_email();
  v_nome  text;
  v_e164  text := public.whatsapp_normalizar_telefone(p_telefone);
  v_ident record;
  v_id    uuid;
  v_novo  boolean := false;
BEGIN
  IF NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'acesso negado' USING ERRCODE = '42501';
  END IF;

  IF v_e164 IS NULL THEN
    RAISE EXCEPTION 'telefone invalido: informe DDD e numero' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_canal FROM public.whatsapp_canais WHERE id = p_canal_id;
  IF NOT FOUND OR NOT v_canal.ativo THEN
    RAISE EXCEPTION 'canal inativo' USING ERRCODE = '42501';
  END IF;

  IF v_canal.conexao_status <> 'CONECTADO' THEN
    RAISE EXCEPTION 'numero % esta % - reconecte antes de iniciar conversa',
      v_canal.apelido, v_canal.conexao_status USING ERRCODE = '42501';
  END IF;

  IF NOT public.whatsapp_remetente_autorizado(p_canal_id, v_email) THEN
    RAISE EXCEPTION 'o numero % e restrito: seu usuario nao envia por ele', v_canal.apelido
      USING ERRCODE = '42501';
  END IF;

  SELECT u.nome INTO v_nome FROM public.usuarios u WHERE u.email = v_email;

  SELECT c.* INTO v_conv
  FROM public.whatsapp_conversas c
  WHERE c.canal_id = p_canal_id AND c.telefone_e164 = v_e164
  FOR UPDATE;

  IF FOUND THEN
    IF v_conv.responsavel_email IS NOT NULL
       AND v_conv.responsavel_email <> v_email
       AND NOT public.usuario_e_gestao() THEN
      RAISE EXCEPTION 'ja existe conversa com este numero, em atendimento por %',
        coalesce(v_conv.responsavel_nome, v_conv.responsavel_email) USING ERRCODE = '42501';
    END IF;

    v_id := v_conv.id;

    PERFORM public.whatsapp_cadencia_checar(p_canal_id, v_id, v_email);

    UPDATE public.whatsapp_conversas c
    SET responsavel_email = coalesce(c.responsavel_email, v_email),
        responsavel_nome  = coalesce(c.responsavel_nome, v_nome, v_email),
        responsavel_desde = coalesce(c.responsavel_desde, now()),
        status            = CASE WHEN c.status = 'ENCERRADO' THEN 'EM_ATENDIMENTO' ELSE c.status END,
        aluno_id          = coalesce(p_aluno_id, c.aluno_id),
        atualizado_em     = now()
    WHERE c.id = v_id;

  ELSE
    v_novo := true;

    SELECT * INTO v_ident FROM public.whatsapp_identificar_aluno(v_e164);

    INSERT INTO public.whatsapp_conversas (
      canal_id, telefone_e164, nome_perfil, status,
      aluno_id, aluno_nome, aluno_status, aluno_candidatos, aluno_identificado_em,
      origem_sync, responsavel_email, responsavel_nome, responsavel_desde
    ) VALUES (
      p_canal_id, v_e164, NULL, 'EM_ATENDIMENTO',
      coalesce(p_aluno_id, v_ident.aluno_id), v_ident.aluno_nome, v_ident.situacao,
      v_ident.candidatos, now(), false,
      v_email, coalesce(v_nome, v_email), now()
    )
    RETURNING id INTO v_id;

    -- A conversa nasce e SO ENTAO passa pela cadencia. Se barrar, a excecao
    -- desfaz o INSERT junto: nao sobra conversa vazia na caixa de entrada.
    PERFORM public.whatsapp_cadencia_checar(p_canal_id, v_id, v_email);
  END IF;

  RETURN QUERY SELECT v_id, v_canal.sessao_chave, v_e164, v_email, NOT v_novo;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_remetente_autorizado(p_canal_id uuid, p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when k.remetentes_autorizados is null or cardinality(k.remetentes_autorizados) = 0 then true
    else lower(coalesce(p_email,'')) = any (
      select lower(e) from unnest(k.remetentes_autorizados) e)
  end
  from public.whatsapp_canais k where k.id = p_canal_id;
$function$
;

-- Permissoes ---------------------------------------------------------------
revoke all on function public.whatsapp_canal_arquivar(uuid, boolean) from public, anon;
revoke all on function public.whatsapp_canais_listar(boolean) from public, anon;
revoke all on function public.whatsapp_remetente_autorizado(uuid, text) from public, anon;
revoke all on function public.whatsapp_canal_remetentes_salvar(uuid, text[]) from public, anon;
revoke all on function public.projecao_pagamentos_dono_divergente(date, date) from public, anon;
grant execute on function public.whatsapp_canal_arquivar(uuid, boolean) to authenticated;
grant execute on function public.whatsapp_canais_listar(boolean) to authenticated;
grant execute on function public.whatsapp_remetente_autorizado(uuid, text) to authenticated;
grant execute on function public.whatsapp_canal_remetentes_salvar(uuid, text[]) to authenticated;
grant execute on function public.prazo_acionamento_base_vigente() to authenticated;
grant execute on function public.projecao_pagamentos_dono_divergente(date, date) to authenticated;
