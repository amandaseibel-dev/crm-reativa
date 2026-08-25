-- Fila de Acordos: caso zerado sai da fila.
--
-- Medido em prod (2026-08-25): dos 2.071 acordos "A confirmar", 40 linhas
-- (36 alunos, R$ 56.875,53 de valor de acordo) são de gente que NÃO DEVE MAIS
-- NADA -- 37 têm acordo QUITADO e nenhum tem parcela em aberto. O operador
-- ligava para confirmar um acordo de alguém que já pagou.
--
-- O caso NÃO é apagado: ganha o status ENCERRADO_SEM_SALDO, some das três abas
-- de trabalho (A confirmar / Confirmados / Rejeitados) e continua achável em
-- "Todos" e na aba própria. Reversível: basta reabrir a linha.
--
-- Saldo vem de public.crm_origem_divida_solicitacao -> aluno_saldo_pendente_detalhe,
-- a MESMA regra da quitação, do saldo zero e da fila de confirmação. Aqui não
-- se redefine saldo, só se lê. Isso importa no caso do acordo CANCELADO: acordo
-- cancelado DEVOLVE a dívida, e a regra canônica já reconta os títulos
-- negociados órfãos -- então quem tem acordo cancelado com dívida de volta
-- aparece como MENSALIDADE e NÃO é encerrado aqui.
--
-- Escopo: só o campo status_confirmacao/observacao da fila de acordos. NÃO dá
-- baixa, NÃO quita, NÃO mexe em acordo, parcela, título, carteira ou operador.
-- Rollback: supabase/rollbacks/20260825190000_fila_acordos_sair_sem_saldo.rollback.sql

create or replace function public.fila_acordos_sair_sem_saldo(
    p_dry_run boolean default true,
    p_limite  int     default 500
  )
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_ids   uuid[];
  v_qtd   int := 0;
  v_valor numeric := 0;
begin
  if not public.usuario_e_gestao_fila() then
    raise exception 'Usuario nao autorizado a encerrar casos da fila de acordos.'
      using errcode = '42501';
  end if;

  -- Candidatos: pendentes cujo aluno NÃO tem nenhuma parcela em aberto. Esse
  -- filtro barato corta 2.000+ linhas antes de chamar a regra canônica (que é
  -- cara), e é conservador: quem tem parcela aberta nunca entra aqui.
  --
  -- O limite é sobre os ENCONTRADOS (não sobre os candidatos): assim ele nunca
  -- esconde caso zerado que ficou fora de um top-N arbitrário -- só reparte o
  -- trabalho em rodadas, do maior valor para o menor.
  with achados as (
    select f.id, f.valor_total
    from public.fila_acordos_confirmar f
    where coalesce(f.status_confirmacao, 'A_CONFIRMAR') = 'A_CONFIRMAR'
      and f.aluno_id is not null
      and not exists (
        select 1
          from public.parcelas p
          join public.acordos a on a.id = p.acordo_id
         where a.aluno_id = f.aluno_id
           and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
           and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
      )
      -- Confirmação pela regra canônica (pega título/mensalidade em aberto,
      -- inclusive dívida que voltou de acordo cancelado).
      and public.crm_origem_divida_solicitacao(f.aluno_id::text, f.cpf) = 'SEM_SALDO'
    order by f.valor_total desc, f.id
    limit greatest(coalesce(p_limite, 500), 0)
  )
  select coalesce(array_agg(id), '{}'), count(*), coalesce(sum(valor_total), 0)
    into v_ids, v_qtd, v_valor
  from achados;

  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'encerrariam', v_qtd,
                              'valor_acordos', round(v_valor, 2));
  end if;

  update public.fila_acordos_confirmar
     set status_confirmacao = 'ENCERRADO_SEM_SALDO',
         confirmado_em      = now(),
         observacao         = nullif(btrim(
                                coalesce(observacao,'') ||
                                case when coalesce(observacao,'') <> '' then ' — ' else '' end ||
                                'Encerrado sem saldo: aluno sem parcela e sem mensalidade em aberto.'), '')
   where id = any (v_ids);
  get diagnostics v_qtd = row_count;

  return jsonb_build_object('dry_run', false, 'encerrados', v_qtd,
                            'valor_acordos', round(v_valor, 2));
end;
$function$;

revoke all on function public.fila_acordos_sair_sem_saldo(boolean, int) from public, anon;
grant execute on function public.fila_acordos_sair_sem_saldo(boolean, int) to authenticated, service_role;
