-- Definicoes de producao (somente leitura, 2026-11-18), geradas de funcoes_responsavel_prod.json.
set check_function_bodies = off;

-- internal.set_resp_acordo(p_acordo_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text) · md5(prosrc) fbb188b5e3486f6bdbae395aa274f2dc · owner reativa_responsavel_executor
CREATE OR REPLACE FUNCTION internal.set_resp_acordo(p_acordo_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ant text; v_aluno uuid; v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select operador_responsavel_email, aluno_id into v_ant, v_aluno from public.acordos where id=p_acordo_id;
  update public.acordos set operador_responsavel_email=v_email, atualizado_em=now() where id=p_acordo_id;
  insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,operador_anterior_email,operador_novo_email,operador_novo_nome,registrado_por_nome,registrado_por_email,registrado_em)
  values (v_aluno::text, p_tipo, p_descricao, v_ant, v_email, p_novo_nome, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end;$function$;

-- internal.set_resp_aluno(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text) · md5(prosrc) f50a76ebc90ccf90ad3eff87aa5566e4 · owner reativa_responsavel_executor
CREATE OR REPLACE FUNCTION internal.set_resp_aluno(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ant_email text; v_ant_nome text; v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome from public.alunos where id=p_aluno_id;
  update public.alunos set
    responsavel_atual_email=v_email,
    responsavel_atual_nome=p_novo_nome,
    responsavel_atual_em=now(),
    data_ultimo_acionamento = case when v_ant_email is distinct from v_email then null else data_ultimo_acionamento end,
    status_acionamento      = case when v_ant_email is distinct from v_email then null else status_acionamento end,
    proxima_acao            = case when v_ant_email is distinct from v_email then null else proxima_acao end,
    data_retorno            = case when v_ant_email is distinct from v_email then null else data_retorno end,
    hora_retorno            = case when v_ant_email is distinct from v_email then null else hora_retorno end
  where id=p_aluno_id;
  insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email, p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end;$function$;

-- public._acordo_herda_responsavel_do_aluno() · md5(prosrc) 7b72a88e9113d5e52b3fb1abcf4cf8a2 · owner postgres
CREATE OR REPLACE FUNCTION public._acordo_herda_responsavel_do_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text; v_nome text; v_ctx text;
begin
  -- ACORDO SEM CREDITO INDIVIDUAL (18/09/2026): pagamento de origem externa que
  -- a gestao autorizou. So vale com a chave transacional acesa E o registrador
  -- do acordo a vista na pilha de chamada; fora disso, nada muda.
  if coalesce(current_setting('reativa.acordo_sem_credito', true), 'off') = 'on' then
    get diagnostics v_ctx = pg_context;
    if position('function acordo_avista_registrar(uuid,uuid[],boolean)' in v_ctx) > 0 then
      return new;
    end if;
  end if;
  if new.operador_responsavel_email is not null then return new; end if;
  select al.responsavel_atual_email, al.responsavel_atual_nome
    into v_email, v_nome
    from public.alunos al where al.id = new.aluno_id;
  if v_email is not null then
    new.operador_responsavel_email := v_email;
    new.operador_responsavel_nome  := coalesce(new.operador_responsavel_nome, v_nome);
  end if;
  return new;
end;
$function$;

-- public._aluno_segue_dono_do_acordo() · md5(prosrc) 12ee44bae0a09ec3806eb483aa39035a · owner postgres
CREATE OR REPLACE FUNCTION public._aluno_segue_dono_do_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare v_mensalidade numeric; v_e_operador boolean;
begin
  -- Remanejamento de ACORDO em curso: quem move o acordo decidiu mover SO o
  -- acordo. A ficha e o caso ficam onde estao -- e a propria funcao que move
  -- confere isso depois, comparando o antes e o depois.
  --
  -- A CHAVE SOZINHA NAO BASTA. `authenticated` tem UPDATE em acordos (RLS
  -- permite os proprios e os sem dono), e qualquer um pode chamar set_config
  -- na propria sessao -- a flag seria forjavel. Ela nao daria acesso novo (o
  -- efeito de forjar e a ficha NAO vir junto, ou seja, ganhar menos), mas
  -- tambem nao e de graca: desacopla acordo e ficha fora do fluxo previsto.
  -- Entao a flag so vale se a PILHA provar que a chamada veio de dentro das
  -- funcoes de remanejamento de acordo. pg_context nao e forjavel por quem nao
  -- pode criar funcao, e `authenticated` nao pode.
  if coalesce(current_setting('reativa.remanejando_acordo', true), '') = '1' then
    declare v_ctx text;
    begin
      get diagnostics v_ctx = pg_context;
      if v_ctx like '%carteira_geral_acordos_mover%'
         or v_ctx like '%carteira_geral_acordos_desfazer_lote%' then
        return new;
      end if;
    end;
  end if;

  if nullif(trim(coalesce(new.operador_responsavel_email,'')),'') is null then return new; end if;
  if upper(coalesce(new.status,'')) <> 'ATIVO' then return new; end if;
  if exists (select 1 from public.alunos al where al.id = new.aluno_id and lower(coalesce(al.responsavel_atual_email,'')) = internal.carteira_geral_email()) then return new; end if;

  -- lancamento feito pela bancada (gerencia/ADM/supervisao) NAO muda o dono
  select (u.perfil = 'operador' and u.ativo) into v_e_operador
    from public.usuarios u where lower(u.email) = lower(new.operador_responsavel_email);
  if coalesce(v_e_operador, false) = false then return new; end if;

  select (public.aluno_saldo_pendente_detalhe(new.aluno_id)->>'titulos_abertos')::numeric
    into v_mensalidade;
  -- com mensalidade em aberto o nivelamento continua livre para redistribuir
  if coalesce(v_mensalidade, 0) > 0.005 then return new; end if;

  begin
    perform set_config('reativa.dono_por_acordo', '1', true);
    update public.alunos
       set responsavel_atual_email = new.operador_responsavel_email,
           responsavel_atual_nome = coalesce(new.operador_responsavel_nome, responsavel_atual_nome)
     where id = new.aluno_id
       and lower(coalesce(responsavel_atual_email,'')) is distinct from lower(new.operador_responsavel_email);
    perform set_config('reativa.dono_por_acordo', '0', true);
  exception when others then
    -- nunca bloquear a troca do acordo por causa do alinhamento do aluno
    perform set_config('reativa.dono_por_acordo', '0', true);
  end;

  return new;
end;
$function$;

-- public._guard_resp_acordo() · md5(prosrc) 9f2f4eef4c2233c41eb9dbf21bff514b · owner postgres
CREATE OR REPLACE FUNCTION public._guard_resp_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.operador_responsavel_email is distinct from old.operador_responsavel_email then
    if current_user = 'reativa_responsavel_executor' then return new; end if;
    if coalesce(current_setting('app.vinculo_resp_acordo_ok', true), 'off') = 'on' then
      return new;
    end if;
    raise exception 'SEM_PERMISSAO_ALTERAR_RESPONSAVEL_ACORDO';
  end if;
  return new;
end;
$function$;

-- public._guard_resp_aluno() · md5(prosrc) 3bea001e4da32a1d88f2a57a0419e6d8 · owner postgres
CREATE OR REPLACE FUNCTION public._guard_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    if current_user = 'reativa_responsavel_executor' then return new; end if;
    -- alinhamento automatico do dono quando a divida e so de acordo
    if coalesce(current_setting('reativa.dono_por_acordo', true), '') = '1' then return new; end if;
    -- auto-atribuicao de caso livre (regra existente)
    if old.responsavel_atual_email is null
       and lower(coalesce(new.responsavel_atual_email,'')) = lower(coalesce(auth.jwt()->>'email','')) then
      return new;
    end if;
    raise exception 'SEM_PERMISSAO_ALTERAR_RESPONSAVEL_ALUNO';
  end if;
  return new;
end;
$function$;

-- public._nome_do_operador_no_aluno() · md5(prosrc) da8cd7aa6cd92344f067dd020f53a79e · owner postgres
CREATE OR REPLACE FUNCTION public._nome_do_operador_no_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then new.operador_nome := v_nome; end if;
  end if;
  if new.responsavel_atual_email is not null then
    v_nome := public.nome_do_operador(new.responsavel_atual_email);
    if v_nome is not null then new.responsavel_atual_nome := v_nome; end if;
  end if;
  return new;
end;
$function$;

-- public._nome_do_operador_no_caso() · md5(prosrc) eeb95272b1fb43a5d97736033b1ac948 · owner postgres
CREATE OR REPLACE FUNCTION public._nome_do_operador_no_caso()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then
      new.operador_nome := v_nome;
      new.operador := v_nome;
    end if;
  end if;
  return new;
end;
$function$;

-- public._sync_casos_resp_aluno() · md5(prosrc) d48308c15206fed5ac702d23e4a6d92f · owner postgres
CREATE OR REPLACE FUNCTION public._sync_casos_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    update public.casos
       set operador_email = lower(new.responsavel_atual_email),
           operador_nome  = new.responsavel_atual_nome,
           operador       = new.responsavel_atual_nome,
           caso_atualizado_por = coalesce(new.registrado_por_email, lower(coalesce(auth.jwt() ->> 'email',''))),
           caso_atualizado_em  = now()
     where aluno_id = new.id;
  end if;
  return new;
end;
$function$;

-- public.atribuir_responsavel_por_acordo() · md5(prosrc) 7d3fccce47cff3ca31a5f98833101cb0 · owner postgres
CREATE OR REPLACE FUNCTION public.atribuir_responsavel_por_acordo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_aid uuid; v_atual text; v_nome text; v_aluno_nome text;
  v_valor_br text; v_mudou boolean; v_aluno_id text; v_e_operador boolean;
begin
  if coalesce(new.operador_responsavel_email,'') = '' then return new; end if;
  if lower(new.operador_responsavel_email) = internal.carteira_geral_email() then return new; end if;

  v_aluno_id := nullif(btrim(coalesce(new.aluno_id::text, '')), '');
  begin v_aid := v_aluno_id::uuid; exception when others then v_aid := null; end;

  select coalesce(nome, new.operador_responsavel_email),
         (ativo and perfil = 'operador')
    into v_nome, v_e_operador
    from public.usuarios where lower(email) = lower(new.operador_responsavel_email) limit 1;

  v_mudou := (TG_OP = 'INSERT')
             or (TG_OP = 'UPDATE'
                 and coalesce(old.operador_responsavel_email,'') is distinct from coalesce(new.operador_responsavel_email,''));

  if v_mudou then
    if v_aid is not null then
      select nome into v_aluno_nome from public.alunos where id = v_aid;
    end if;
    v_valor_br := replace(to_char(coalesce(new.valor_total,0), 'FM999999990.00'), '.', ',');

    insert into public.notificacoes
      (usuario_destino_nome, usuario_destino_email, tipo, titulo, mensagem, aluno_id, url_destino, lida)
    values (
      coalesce(v_nome, new.operador_responsavel_email), new.operador_responsavel_email,
      'RESPONSAVEL_ACORDO', '🤝 Novo acordo sob sua responsabilidade',
      'Você é o responsável por um acordo de R$ ' || v_valor_br
        || ' do aluno ' || coalesce(v_aluno_nome, new.cpf, 'aluno')
        || '. Clique em Abrir para tratar o caso.',
      v_aid,
      case when v_aluno_id is not null then '/aluno?alunoId=' || v_aluno_id else '/painel-carteira' end,
      false);
  end if;

  if v_aid is not null and coalesce(v_e_operador, false) then
    select responsavel_atual_email into v_atual from public.alunos where id = v_aid;
    if coalesce(trim(v_atual),'') = '' then
      perform internal.set_resp_aluno(
        v_aid, new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email),
        'ATRIBUICAO_ACORDO', 'Responsavel definido pelo acordo',
        new.operador_responsavel_email, coalesce(v_nome, new.operador_responsavel_email));
    end if;
  end if;

  return new;
end;
$function$;

-- public.nome_do_operador(p_email text) · md5(prosrc) 8f8738dd17902f48ca897674d9e1fb9c · owner postgres
CREATE OR REPLACE FUNCTION public.nome_do_operador(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(nullif(btrim(u.operador_nome), ''), nullif(btrim(u.nome), ''))
  from public.usuarios u
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
$function$;

-- public.trg_sincronizar_alunos_apos_casos() · md5(prosrc) 158f905cba8f85d19f8a51b052f8b556 · owner postgres
CREATE OR REPLACE FUNCTION public.trg_sincronizar_alunos_apos_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
DECLARE
  v_nome text;
  mapa_nomes jsonb := '{
    "cobranca03@aelbra.com.br": "OLGA", "cobranca04@aelbra.com.br": "FERNANDA",
    "cobranca05@aelbra.com.br": "LUANA", "cobranca06@aelbra.com.br": "MAURICIO",
    "cobranca07@aelbra.com.br": "AMANDA ADM", "cobranca08@aelbra.com.br": "NATALI",
    "cobranca10@aelbra.com.br": "JOÃO", "cobranca11@aelbra.com.br": "ALLAN",
    "cobranca12@aelbra.com.br": "RAFAELLA", "cobranca13@aelbra.com.br": "DIEGO",
    "amanda.seibel@aelbra.com.br": "AMANDA GESTORA"
  }'::jsonb;
BEGIN
  IF NEW.aluno_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.operador_email IS DISTINCT FROM OLD.operador_email THEN
    v_nome := CASE WHEN NEW.operador_email IS NULL THEN NULL
                   ELSE COALESCE(mapa_nomes ->> lower(NEW.operador_email), NEW.operador_nome) END;
    PERFORM internal.set_resp_aluno(NEW.aluno_id, NEW.operador_email, v_nome,
      'REDISTRIBUICAO_SINCRONIZACAO', 'Sincronizacao automatica em tempo real (gatilho).',
      'sistema@reativaone', 'Sistema');
  END IF;
  RETURN NEW;
END;
$function$;

set check_function_bodies = on;
