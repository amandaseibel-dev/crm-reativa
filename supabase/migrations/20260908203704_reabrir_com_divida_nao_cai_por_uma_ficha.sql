-- O cron `casos_reabrir_com_divida_horario` estava caido HA 96 HORAS: 96
-- execucoes seguidas, nenhuma bem-sucedida, desde 04/09/2026 17:35. Cron que
-- falha nao avisa ninguem, entao ninguem viu.
--
-- Resultado medido em 08/09: 150 casos / 149 alunos / R$ 1.238.880,02 que
-- deveriam ter voltado para a fila e estavam fora dela. Sao alunos que voltaram
-- a ter divida e que nenhum operador estava enxergando.
--
-- A CAUSA, que e fina:
--
-- A funcao ja tinha a trava certa -- "so reabre quem nao tem NENHUM caso
-- aberto". Mas ela mora no `select` que abre o laco, e um cursor e uma
-- FOTOGRAFIA: a condicao vale para o estado do banco no comeco, nao para o
-- estado depois que o proprio laco comecou a reabrir casos.
--
-- O aluno deb45012-abe1-4e72-902f-294fae7d41cb tinha DOIS casos encerrados que
-- se qualificavam (fde64446 "Em cobranca" e bf60d7a1 "Acordo quebrado"). O laco
-- reabria o primeiro; ao reabrir o segundo, o gatilho _caso_nao_duplica_aluno()
-- levantava ALUNO_JA_TEM_CASO_ABERTO -- corretamente, alias, porque a essa
-- altura o aluno JA estava na fila. So que a funcao inteira e uma transacao:
-- o erro derrubava tudo e as outras 149 fichas voltavam atras junto.
--
-- Uma ficha derrubava a rotina inteira, de hora em hora, por quatro dias.
--
-- DOIS CONSERTOS, e os dois sao necessarios:
--
-- 1. Re-checar a trava DENTRO do laco, com o mesmo criterio do gatilho. E a
--    correcao de verdade: o estado mudou desde a fotografia, entao a decisao
--    tem que ser tomada agora, nao la atras.
--
-- 2. Cada ficha em seu proprio `begin/exception`. E a rede de seguranca: a
--    proxima causa de erro nao vai ser esta, e quando ela aparecer nao pode
--    levar junto as outras 149 fichas que nao tem nada a ver. O que falha e
--    pulado e registrado como WARNING no log do Postgres; o resto passa.
--
-- O retorno continua sendo a quantidade REABERTA, para nao quebrar quem chama.
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
  v_pulados integer := 0;
  v_falhas integer := 0;
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
       -- (Continua aqui porque poda a lista cedo; a decisao final e no laco.)
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
    -- CONSERTO 1. A lista acima e uma fotografia. Se o proprio laco ja devolveu
    -- OUTRO caso deste aluno para a fila, este aqui nao entra: a ficha do aluno
    -- e unica. Mesmo criterio do gatilho _caso_nao_duplica_aluno(), para a
    -- decisao aqui e a trava la nunca discordarem.
    if exists (
      select 1 from public.casos c2
       where c2.aluno_id = r.aluno_id
         and c2.id <> r.id
         and not coalesce(c2.encerrado_operacional, false)
         and public.caso_encerrado_operacional(c2.cpf, c2.status_atual, c2.status_acionamento,
                                               c2.status_financeiro, c2.status_jornada) = false
    ) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    -- CONSERTO 2. Uma ficha ruim nunca mais leva junto as outras.
    begin
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
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'casos_reabrir_com_divida: caso % do aluno % nao foi reaberto e foi pulado: %',
        r.id, r.aluno_id, sqlerrm;
    end;
  end loop;

  if v_pulados > 0 or v_falhas > 0 then
    raise warning 'casos_reabrir_com_divida: % reaberto(s), % pulado(s) por ja terem caso aberto, % com erro',
      v_n, v_pulados, v_falhas;
  end if;

  return v_n;
end;
$function$;
