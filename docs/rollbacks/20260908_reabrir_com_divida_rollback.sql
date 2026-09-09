-- ROLLBACK da migration 20260908210000_reabrir_com_divida_nao_cai_por_uma_ficha.
--
-- Esta e a definicao EXATA que estava em producao em 08/09/2026, capturada com
-- pg_get_functiondef ANTES da troca. Rodar isto devolve o comportamento antigo
-- -- inclusive o defeito: uma ficha com caso duplicado volta a derrubar a
-- rotina inteira. So use se o conserto causar algo pior.
--
-- As fichas reabertas pelo mutirao de drenagem ficaram copiadas em
-- _backup_reabrir_com_divida_20260908 (RLS deny-all), com o estado ANTERIOR de
-- cada uma.
CREATE OR REPLACE FUNCTION public.casos_reabrir_com_divida(p_limite integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  v_n integer := 0;
  r record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       and not exists (
         select 1 from public.casos c2
          where c2.aluno_id = c.aluno_id and c2.id <> c.id
            and not coalesce(c2.encerrado_operacional, false))
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    update public.casos
       set status_atual = 'Em cobrança',
           status_acionamento = null,
           status_jornada = 'Em cobrança',
           status_financeiro = case
             when public.normalizar_status_acionamento(coalesce(status_financeiro,''))
                  in ('QUITADO','PAGO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                      'SEM SALDO EM ABERTO','SALDO ZERO CONFIRMADO')
               then null
             else status_financeiro end,
           encerrado_operacional = false,
           caso_atualizado_por = 'sistema_reabrir_com_divida',
           caso_atualizado_em = now()
     where id = r.id;

    update public.alunos
       set status_atual = 'Em cobrança',
           status_jornada = 'Em cobrança',
           status_acionamento = null
     where id = r.aluno_id
       and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo,
       registrado_por_nome, registrado_por_email, registrado_em)
    values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
            'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
            || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
            coalesce(r.st_ant,'(sem)'), 'Em cobrança',
            'Sistema', 'sistema_reabrir_com_divida', now());

    perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;
