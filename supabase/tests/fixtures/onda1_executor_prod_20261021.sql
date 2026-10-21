-- QUARTA CAMADA DA BANCADA — o que o EXECUTOR da Onda 1 precisa, corpos de
-- PRODUÇÃO de 21/10/2026.
--
-- As três camadas anteriores já dão as tabelas e as guardas. Falta aqui o que o
-- executor encosta: a tabela de auditoria, a aprovação da gestão e -- o que mais
-- importa -- OS GATILHOS DE `casos`. Sem eles o teste seria teatro: é
-- exatamente nos gatilhos que mora a prova de que nenhum caso já atribuído é
-- liberado e de que a fidelização de 10 dias sobrevive à troca de dono.
--
-- Cada corpo é o EXATO de produção e o teste confere um por um por md5(prosrc).
--
-- NENHUM DADO REAL: só estrutura, corpo de função e gatilho.

-- ---------------------------------------------------------------------------
-- Auditoria: o registro individual de cada movimentação. Append-only.
-- ---------------------------------------------------------------------------
create table if not exists public.calibragem_auditoria (
  id uuid primary key default gen_random_uuid(),
  evento text,
  simulacao_id uuid,
  caso_id uuid,
  chave_unificacao text,
  aluno_id uuid,
  cpf text,
  nome_aluno text,
  operador_anterior_email text,
  operador_anterior_nome text,
  operador_novo_email text,
  operador_novo_nome text,
  valor_caso numeric,
  motivo text,
  regra text,
  caso_compensacao_id uuid,
  situacao_anterior jsonb,
  situacao_posterior jsonb,
  aprovado_por_email text,
  aprovado_por_nome text,
  registrado_por_email text,
  registrado_em timestamptz not null default now()
);

CREATE OR REPLACE FUNCTION public.calibragem_auditoria_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin raise exception 'calibragem_auditoria é append-only: % não permitido.', tg_op; end; $function$;

drop trigger if exists trg_calibragem_auditoria_no_upd on public.calibragem_auditoria;
create trigger trg_calibragem_auditoria_no_upd
  before update or delete on public.calibragem_auditoria
  for each row execute function public.calibragem_auditoria_append_only();

-- ---------------------------------------------------------------------------
-- A aprovação explícita da gestão. É o portão que o executor exige.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calibragem_aprovar_simulacao(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_email text := coalesce(auth.jwt() ->> 'email','server'); v_status text;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then raise exception 'Sem permissão para aprovar a Calibragem.'; end if;
  select status into v_status from public.calibragem_simulacoes where id=p_id for update;
  if not found then raise exception 'Simulação % não encontrada.', p_id; end if;
  if v_status <> 'RASCUNHO' then raise exception 'Só é possível aprovar uma simulação RASCUNHO (atual: %).', v_status; end if;
  update public.calibragem_simulacoes set status='APROVADA', aprovado_por_email=v_email, aprovado_por_nome=v_email, aprovado_em=now() where id=p_id;
  return jsonb_build_object('id', p_id, 'status', 'APROVADA');
end; $function$;

-- ---------------------------------------------------------------------------
-- Funções de apoio dos gatilhos.
-- ---------------------------------------------------------------------------
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

CREATE OR REPLACE FUNCTION public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$;

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

create schema if not exists internal;

CREATE OR REPLACE FUNCTION internal.matricula_em_fidelizacao(p_aluno_id uuid, p_matricula text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH alvo AS (
    SELECT p_aluno_id AS aid WHERE p_aluno_id IS NOT NULL
    UNION ALL
    SELECT a.id FROM public.alunos a
    WHERE p_aluno_id IS NULL AND nullif(btrim(p_matricula),'') IS NOT NULL
      AND btrim(a.matricula) = btrim(p_matricula)
      AND (SELECT count(*) FROM public.alunos a2 WHERE btrim(a2.matricula) = btrim(p_matricula)) = 1
  )
  SELECT EXISTS (
    SELECT 1 FROM alvo JOIN public.alunos a ON a.id = alvo.aid
    WHERE a.responsavel_atual_email IS NOT NULL AND a.responsavel_atual_em IS NOT NULL
      AND a.responsavel_atual_em > now() - interval '10 days'
  );
$function$;

-- ---------------------------------------------------------------------------
-- OS GATILHOS DE `casos`, na ordem que importa. O sufixo `zz` do último não é
-- enfeite: nomes de gatilho BEFORE disparam em ordem alfabética, e ele tem de
-- ver a linha depois de todos os outros.
-- ---------------------------------------------------------------------------

-- Preserva encerrado_operacional quando nada de status muda. É o que faz os 7
-- pares de ficha duplicada passarem: o caso fechado do par continua fechado.
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

-- Zera a marca de giro quando o dono muda E a marca não muda na mesma linha.
CREATE OR REPLACE FUNCTION public.giro_limpar_marca_ao_trocar_dono()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.operador_email is not null
     and NEW.operador_email is distinct from OLD.operador_email
     and OLD.giro_fidelizacao_ate is not null
     and NEW.giro_fidelizacao_ate is not distinct from OLD.giro_fidelizacao_ate then
    NEW.giro_fidelizacao_ate := null;
  end if;
  return NEW;
end;
$function$;

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

-- O gatilho perigoso: libera caso de OUTRO aluno do mesmo operador para caber
-- no teto. É por isso que o executor liga calibragem.bypass_teto depois de o
-- pré-voo garantir o teto.
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_meta int; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  IF coalesce(current_setting('calibragem.bypass_teto', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN RETURN NEW; END IF;
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN RETURN NEW; END IF;

  -- Teto da gestao (geral ou individual). Cai em 500 se nao houver parametro.
  v_meta := public.calibragem_teto_operador(v_email);

  SELECT count(*) INTO v_qtd_ativa FROM public.casos c WHERE c.operador_email = v_email
    AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN RETURN NEW; END IF;
  FOR caso_rec IN SELECT id, chave_unificacao, nome, cpf FROM public.casos c WHERE c.operador_email = v_email AND c.id <> NEW.id
      AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
      AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
     AND c.giro_fidelizacao_ate IS NULL
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido apos atribuicao manual -- liberado automaticamente (menor valor, fora dos 10 dias de fidelizacao)', now());
  END LOOP;
  RETURN NEW;
END; $function$;

-- Reposição: só dispara quando o dono NÃO muda. Na Onda 1 o dono sempre muda,
-- então ele não entra -- e o teste prova isso em vez de supor.
CREATE OR REPLACE FUNCTION public.trg_repor_caso_operador()
 RETURNS trigger
 LANGUAGE plpgsql
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

-- Um CPF, uma ficha. Levanta ALUNO_JA_TEM_CASO_ABERTO.
CREATE OR REPLACE FUNCTION public._caso_nao_duplica_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_outro_id     uuid;
  v_outro_codigo integer;
  v_nome         text;
begin
  if new.aluno_id is null then return new; end if;
  if coalesce(new.encerrado_operacional, false) then return new; end if;
  if public.caso_encerrado_operacional(new.cpf, new.status_atual, new.status_acionamento,
                                       new.status_financeiro, new.status_jornada) then
    return new;
  end if;

  select c.id, c.caso_codigo into v_outro_id, v_outro_codigo
    from public.casos c
   where c.aluno_id = new.aluno_id
     and c.id <> new.id
     and not coalesce(c.encerrado_operacional, false)
     and public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada) = false
   limit 1;

  if v_outro_id is null then return new; end if;

  select coalesce(nullif(btrim(a.nome), ''), '(sem nome)') into v_nome
    from public.alunos a where a.id = new.aluno_id;

  -- REABERTURA: a ficha ja estava encerrada e alguem (importacao, rotina) esta
  -- acordando ela enquanto o aluno tem outra ficha aberta. Nao derruba o lote:
  -- mantem encerrada e registra. So vale no gatilho BEFORE, onde ainda da para
  -- mudar a linha; o AFTER, ao ver encerrado_operacional = true, sai na 1a linha.
  if tg_op = 'UPDATE'
     and coalesce(old.encerrado_operacional, false)
     and tg_when = 'BEFORE' then
    new.encerrado_operacional := true;

    insert into public.ficha_reabertura_barrada
      (caso_id, caso_codigo, aluno_id, outro_caso_id, outro_codigo, nome)
    values (new.id, new.caso_codigo, new.aluno_id, v_outro_id, v_outro_codigo, v_nome);

    return new;
  end if;

  -- FICHA NOVA duplicada: continua sendo erro, e alto.
  raise exception
    'ALUNO_JA_TEM_CASO_ABERTO: % ja esta na fila no caso %. A ficha do aluno e unica -- um CPF, uma ficha. Abra o caso existente e trabalhe nele; se sao dois cursos, isso e um campo na ficha, nao uma segunda ficha.',
    coalesce(v_nome, new.aluno_id::text),
    coalesce(v_outro_codigo::text, left(v_outro_id::text, 8));
end;
$function$;

drop trigger if exists trg_casos_set_encerrado_operacional on public.casos;
create trigger trg_casos_set_encerrado_operacional
  before insert or update on public.casos
  for each row execute function public.casos_set_encerrado_operacional();

drop trigger if exists trg_giro_limpar_marca on public.casos;
create trigger trg_giro_limpar_marca
  before update on public.casos
  for each row execute function public.giro_limpar_marca_ao_trocar_dono();

drop trigger if exists trg_nome_do_operador_no_caso on public.casos;
create trigger trg_nome_do_operador_no_caso
  before insert or update of operador_email, operador_nome, operador on public.casos
  for each row execute function public._nome_do_operador_no_caso();

drop trigger if exists trg_zz_caso_nao_duplica_aluno_before on public.casos;
create trigger trg_zz_caso_nao_duplica_aluno_before
  before insert or update on public.casos
  for each row execute function public._caso_nao_duplica_aluno();

drop trigger if exists trigger_impor_teto_operador on public.casos;
create trigger trigger_impor_teto_operador
  after update on public.casos
  for each row execute function public.trg_impor_teto_operador();

drop trigger if exists trigger_repor_caso_operador on public.casos;
create trigger trigger_repor_caso_operador
  after update on public.casos
  for each row
  when (new.operador_email is not null and new.operador_email = old.operador_email)
  execute function public.trg_repor_caso_operador();
