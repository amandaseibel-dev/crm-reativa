-- AMBIENTE DE TESTE (postgres, SOMENTE banco descartável de CI). Simula o mínimo de produção:
-- tabelas com as colunas usadas, RLS e policies com o mesmo desenho medido em produção (15/11),
-- funções de identidade simplificadas (listas de teste) e cópias dos corpos dos gatilhos de origem main.
-- Não é prova da lista real de gestão nem das policies de produção.
\set ON_ERROR_STOP on
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create table alunos (
  id uuid primary key, status_jornada text, status_atual text, status_acionamento text,
  data_ultimo_acionamento timestamptz, data_retorno date, proxima_acao text
);
create table casos (id uuid primary key default gen_random_uuid(), aluno_id uuid, data_ultimo_acionamento date);
create table aluno_movimentacoes (
  id bigserial primary key, aluno_id text not null, tipo text not null, descricao text,
  status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text,
  registrado_em timestamptz default now(), data_retorno date, elogio_print_path text
);
create table chamadas_rotina (nome text);

create or replace function app_email() returns text language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email',''))
$$;
-- Identidade de TESTE: quem é gestão e quem está ativo. Não reproduz a lista de produção.
create or replace function usuario_e_gestao() returns boolean language sql stable as $$
  select app_email() in ('gestao.titular@exemplo.local','gestao.b@exemplo.local','gestao.c@exemplo.local')
$$;
create or replace function app_usuario_ativo() returns boolean language sql stable as $$
  select app_email() in ('gestao.titular@exemplo.local','gestao.b@exemplo.local','gestao.c@exemplo.local','operador.teste@exemplo.local')
$$;

-- Rotinas de acionamento: se forem chamadas, registram. Não devem ser chamadas pelo registro informativo.
create or replace function recalcular_situacao_aluno(a uuid, origem text) returns void language plpgsql as $$
begin insert into chamadas_rotina values ('recalcular_situacao_aluno'); end $$;

-- Corpo de eh_tipo_acionamento conforme a migration de 31/07 (lista fechada).
create or replace function eh_tipo_acionamento(p_tipo text) returns boolean language sql immutable as $b$
  select coalesce(p_tipo,'') in ('FINALIZACAO_ATENDIMENTO','FINALIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','CONTATO',
    'LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','COMPROVANTE_ENVIADO_BAIXA','QUITADO_MANUAL','TERMO_ENVIADO_ADM',
    'RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO')
$b$;

-- Corpos reais de origem main (copiados por script; ver verificação do PR #981).
create or replace function public.fn_atualizar_ultimo_acionamento()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  -- SO AVANCA: um acionamento mais antigo nunca sobrescreve um mais novo.
  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- Acao massiva NAO passa pela recalculadora: ela escreve data_retorno e
  -- status_acionamento, e a campanha nao pode criar retorno nem tabular.
  -- Contato de operador e os demais tipos seguem recalculando como sempre.
  if new.tipo not in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    begin
      perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
    exception when others then
      null;
    end;
  end if;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;

create or replace function public._trg_desfazer_cartao_tabulacao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aluno uuid;
  v_estado jsonb;
  v_nome text;
begin
  if new.tipo <> 'FINALIZACAO_ATENDIMENTO' then
    return null;
  end if;
  if public.app_email() = '' then
    return null;   -- ação de sistema não vira botão de desfazer
  end if;

  begin
    v_aluno := new.aluno_id::uuid;
  exception when others then
    return null;
  end;

  -- Link e termo já criaram o cartão nesta mesma transação (now() é estável
  -- dentro dela) e a movimentação abaixo é parte da MESMA ação. Sem isso,
  -- solicitar link geraria dois cartões. A checagem exclui TABULACAO de
  -- propósito: duas tabulações na mesma transação são duas ações de verdade e
  -- cada uma precisa do seu cartão.
  if exists (
    select 1 from public.acoes_desfazer
     where aluno_id = v_aluno and criado_em = now() and tipo <> 'TABULACAO'
  ) then
    return null;
  end if;

  select ea.estado into v_estado
    from public.alunos_estado_anterior ea
   where ea.aluno_id = v_aluno
     and ea.estado->>'status_atual' is not distinct from new.status_anterior
   order by ea.id desc
   limit 1;

  if v_estado is null then
    select ea.estado into v_estado
      from public.alunos_estado_anterior ea
     where ea.aluno_id = v_aluno
     order by ea.id desc
     limit 1;
  end if;

  -- Sem foto nenhuma ainda dá para voltar o status, que é o que mais dói.
  if v_estado is null then
    v_estado := jsonb_build_object(
      'status_jornada',     new.status_anterior,
      'status_atual',       new.status_anterior,
      'status_acionamento', new.status_anterior
    );
  end if;

  select coalesce(nome_aluno, nome) into v_nome from public.alunos where id = v_aluno;

  insert into public.acoes_desfazer
    (tipo, aluno_id, aluno_nome, movimentacao_id, operador_email, operador_nome,
     rotulo, estado_anterior)
  values
    ('TABULACAO', v_aluno, v_nome, new.id,
     lower(coalesce(new.registrado_por_email, public.app_email())), new.registrado_por_nome,
     'Atendimento tabulado como "' || coalesce(new.status_novo, '-') || '"', v_estado);

  return null;
exception when others then
  return null;
end;
$$;

create or replace function public.sincronizar_elogio_da_movimentacao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_aluno uuid;
  v_obs   text;
BEGIN
  IF coalesce(NEW.status_novo, '') <> 'ELOGIO_ATENDIMENTO' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_aluno := NULLIF(btrim(NEW.aluno_id::text), '')::uuid;
  EXCEPTION WHEN others THEN
    v_aluno := NULL;
  END;

  -- Observação escrita pelo operador na tabulação (ignora o texto automático).
  v_obs := NULLIF(btrim(coalesce(NEW.descricao, '')), '');
  IF v_obs IS NOT NULL AND (v_obs ILIKE 'Atendimento finalizado com status:%' OR v_obs ILIKE 'Atendimento finalizado como %') THEN
    v_obs := NULL;
  END IF;

  INSERT INTO public.elogios_atendimento (
    aluno_id, movimentacao_id, operador_email, operador_nome,
    print_path, print_nome_arquivo, observacao_operador, status,
    registrado_por_email, registrado_por_nome, registrado_em
  )
  VALUES (
    v_aluno,
    NEW.id,
    lower(btrim(NEW.registrado_por_email)),
    coalesce(NULLIF(btrim(NEW.registrado_por_nome), ''), NEW.registrado_por_email),
    NULLIF(btrim(coalesce(NEW.elogio_print_path, '')), ''),
    NEW.elogio_print_nome,
    v_obs,
    'PENDENTE_ANALISE',
    lower(btrim(NEW.registrado_por_email)),
    NEW.registrado_por_nome,
    NEW.registrado_em
  )
  ON CONFLICT (movimentacao_id) DO UPDATE
    SET print_path         = coalesce(public.elogios_atendimento.print_path, excluded.print_path),
        print_nome_arquivo = coalesce(public.elogios_atendimento.print_nome_arquivo, excluded.print_nome_arquivo);

  IF TG_OP = 'UPDATE'
     AND NEW.elogio_rejeitado_tv IS TRUE
     AND coalesce(OLD.elogio_rejeitado_tv, false) IS FALSE THEN
    UPDATE public.elogios_atendimento e
       SET status              = 'REJEITADO_TV',
           motivo_rejeicao     = coalesce(NULLIF(btrim(e.motivo_rejeicao), ''), 'Rejeitado na analise do CRM'),
           analisado_por_email = NEW.elogio_rejeitado_por,
           analisado_em        = coalesce(NEW.elogio_rejeitado_em, now()),
           atualizado_em       = now()
     WHERE e.movimentacao_id = NEW.id
       AND e.status = 'PENDENTE_ANALISE';
  END IF;

  -- Aprovacao vinda do CRM so entra se ja houver texto revisado para a TV.
  IF TG_OP = 'UPDATE'
     AND NEW.elogio_aprovado_tv IS TRUE
     AND coalesce(OLD.elogio_aprovado_tv, false) IS FALSE THEN
    UPDATE public.elogios_atendimento e
       SET status              = 'APROVADO_TV',
           analisado_por_email = NEW.elogio_aprovado_por,
           analisado_em        = coalesce(NEW.elogio_aprovado_em, now()),
           exibir_de           = coalesce(e.exibir_de, (now() AT TIME ZONE 'America/Sao_Paulo')::date),
           atualizado_em       = now()
     WHERE e.movimentacao_id = NEW.id
       AND e.status = 'PENDENTE_ANALISE'
       AND NULLIF(btrim(coalesce(e.texto_final_tv, '')), '') IS NOT NULL;
  END IF;

  RETURN NEW;
END;
$function$;

create trigger trg_atualizar_ultimo_acionamento after insert on aluno_movimentacoes for each row execute function fn_atualizar_ultimo_acionamento();
create trigger trg_zz_desfazer_cartao_tabulacao after insert on aluno_movimentacoes for each row execute function _trg_desfazer_cartao_tabulacao();
create trigger trg_sincronizar_elogio_da_movimentacao after insert on aluno_movimentacoes for each row execute function sincronizar_elogio_da_movimentacao();
