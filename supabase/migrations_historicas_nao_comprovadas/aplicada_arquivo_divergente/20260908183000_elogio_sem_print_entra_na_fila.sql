-- Elogio de atendimento SEM print passa a entrar na fila de análise.
--
-- Sintoma (2026-09-08, Amanda): o elogio registrado pela Luana em 02/09 nunca
-- apareceu em "Elogios de Atendimento" nem na TV. Causa: a ficha do aluno diz
-- "Anexar print do elogio (opcional)", mas o gatilho que leva a tabulação
-- ELOGIO_ATENDIMENTO para a fila descartava em silêncio qualquer elogio sem
-- arquivo, e a própria tabela exigia print (NOT NULL + check). Resultado: 15
-- elogios desde 22/07 nunca chegaram à análise da gestão.
--
-- O que muda:
--   1) elogios_atendimento.print_path vira opcional.
--   2) O gatilho cria a pendência com ou sem print e aproveita a observação
--      que o operador escreveu na tabulação como texto sugerido.
--   3) Backfill: os elogios já registrados sem pendência entram agora como
--      PENDENTE_ANALISE (ou REJEITADO/APROVADO se a ficha já tinha decisão).
-- A tela da fila e a TV já lidam com elogio sem arquivo (botão "Ver anexo" só
-- aparece quando há print; o slide mostra apenas o nome do operador).

alter table public.elogios_atendimento alter column print_path drop not null;
alter table public.elogios_atendimento drop constraint if exists elogios_print_obrigatorio;

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

-- Backfill: elogios já tabulados que nunca viraram pendência.
insert into public.elogios_atendimento (
  aluno_id, movimentacao_id, operador_email, operador_nome,
  print_path, print_nome_arquivo, observacao_operador, status, motivo_rejeicao,
  analisado_por_email, analisado_em, exibir_de,
  registrado_por_email, registrado_por_nome, registrado_em
)
select
  case when m.aluno_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then m.aluno_id::uuid end,
  m.id,
  lower(btrim(m.registrado_por_email)),
  coalesce(nullif(btrim(m.registrado_por_nome), ''), m.registrado_por_email),
  nullif(btrim(coalesce(m.elogio_print_path, '')), ''),
  m.elogio_print_nome,
  case when m.descricao ilike 'Atendimento finalizado com status:%' or m.descricao ilike 'Atendimento finalizado como %' then null
       else nullif(btrim(m.descricao), '') end,
  case when m.elogio_rejeitado_tv is true then 'REJEITADO_TV'
       when m.elogio_aprovado_tv is true then 'APROVADO_TV'
       else 'PENDENTE_ANALISE' end,
  case when m.elogio_rejeitado_tv is true then 'Rejeitado na analise do CRM' else null end,
  case when m.elogio_rejeitado_tv is true then m.elogio_rejeitado_por
       when m.elogio_aprovado_tv is true then m.elogio_aprovado_por end,
  case when m.elogio_rejeitado_tv is true then coalesce(m.elogio_rejeitado_em, now())
       when m.elogio_aprovado_tv is true then coalesce(m.elogio_aprovado_em, now()) end,
  case when m.elogio_aprovado_tv is true
       then coalesce(m.elogio_aprovado_em, m.registrado_em) at time zone 'America/Sao_Paulo' end::date,
  lower(btrim(m.registrado_por_email)),
  m.registrado_por_nome,
  m.registrado_em
from public.aluno_movimentacoes m
where m.status_novo = 'ELOGIO_ATENDIMENTO'
  and m.registrado_por_email is not null
  and not exists (select 1 from public.elogios_atendimento e where e.movimentacao_id = m.id)
on conflict (movimentacao_id) do nothing;
