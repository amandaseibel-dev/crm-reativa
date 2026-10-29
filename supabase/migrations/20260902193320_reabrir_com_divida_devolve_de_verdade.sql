-- O reabridor passa a devolver o caso para a fila DE VERDADE.
--
-- O DEFEITO. `casos_reabrir_com_divida` "reabria" trocando as strings de status
-- (status_atual, status_jornada, status_financeiro) e NUNCA escrevia
-- `encerrado_operacional = false` -- que é o flag que a fila do operador lê.
-- O caso ganhava status de cobrança, gravava a movimentação dizendo "devolvido
-- para a fila", e continuava fora dela.
--
-- POR QUE MORDIA POUCO: a maioria dos encerramentos vem da regra de string
-- (`caso_encerrado_operacional`), e ao trocar os status o caso realmente deixa
-- de ser encerrado por aquela regra. Só quem foi fechado pelo FLAG GRAVADO --
-- pelo cron `casos_reavaliar_encerramento` das :30 -- ficava travado.
--
-- MEDIDO EM 02/09/2026: 103 casos passaram pelo reabridor e 3 seguiam fora da
-- fila (R$ 2.679,22). O sintoma visível era a repetição: como o caso nunca saía
-- do estado encerrado, o cron das :35 o repescava toda hora e gravava outra
-- movimentação. Um aluno acumulou 30 reaberturas, outro 7, outro 6; 133 tiveram
-- 2. Com o flag sendo escrito, a reabertura acontece uma vez e para.
--
-- Achado ao investigar por que o caso 10912 (Gabriel Rocha Mota, R$ 1.178,19,
-- com o cobranca03) aparecia como tocado pelo reabridor no mesmo dia e ainda
-- assim fora da fila.
create or replace function public.casos_reabrir_com_divida(p_limite integer default null::integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180s'
as $function$
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
       -- SO reabre quem nao tem NENHUM caso aberto. Sem isto o reabridor
       -- ressuscita a copia duplicada que a fusao acabou de aposentar.
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
           -- A LINHA QUE FALTAVA. Sem ela o caso mudava de status mas seguia
           -- fora da fila, e o cron o repescava toda hora, gravando outra
           -- movimentacao de reabertura que nao reabria nada.
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
