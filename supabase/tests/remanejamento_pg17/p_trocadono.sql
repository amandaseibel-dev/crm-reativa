-- TROCA DE DONO pelo remanejamento: o que muda e o que tem de sobreviver (B4).
--  (a) retorno agendado (data, hora, origem, proxima acao) fica exatamente como estava;
--  (b) casos.data_retorno fica como estava;
--  (c) a agenda do operador e reapontada para o novo dono, com data/hora (retorno_em) intactas;
--  (d) data_ultimo_acionamento e zerado na troca de dono (regra: troca de operador apaga acionamento).
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
update public.calibragem_parametros set valor = '700'::jsonb where chave = 'limite_carteira';

create temp table _t on commit preserve rows as select * from pg_temp.semear('cobranca05@aelbra.com.br', 500, null, 40);
do $$
declare x record;
begin
  select * into x from _t;
  update public.alunos
     set data_retorno = pg_temp.hoje() + 3, hora_retorno = '10:00', retorno_origem = 'OPERADOR',
         proxima_acao = 'LIGAR', data_ultimo_acionamento = now() - interval '2 days'
   where id = x.aluno;
  update public.casos set data_retorno = pg_temp.hoje() + 3,
         data_ultimo_acionamento = (now() - interval '2 days')::date
   where id = x.caso;
  insert into public.operador_agenda (aluno_id, aluno_nome, operador_email, operador_nome, retorno_em, status)
  values (x.aluno::text, 'Aluno T', 'cobranca05@aelbra.com.br', 'Luana', (now() + interval '3 days')::timestamptz, 'PENDENTE');
end $$;

do $$
declare x record; p jsonb; r jsonb; antes_em timestamptz;
begin
  select * into x from _t;
  select retorno_em into antes_em from public.operador_agenda where aluno_id = x.aluno::text;
  p := pg_temp.previa(array[x.aluno], 'OPERADOR', 'cobranca06@aelbra.com.br');
  r := public.carteira_geral_mover((p->>'previa_id')::uuid, 'troca de dono - retorno e agenda');
  perform pg_temp.afirma((r->>'alunos_movidos')::int = 1, format('troca: aluno movido (alunos_movidos=%s)', r->>'alunos_movidos'));
  perform pg_temp.afirma(pg_temp.dono(x.caso) = 'cobranca06@aelbra.com.br', 'troca: caso com o novo dono');

  -- (a) retorno do aluno preservado
  perform pg_temp.afirma((select data_retorno from public.alunos where id = x.aluno) = pg_temp.hoje() + 3,
    'retorno: data_retorno preservada');
  perform pg_temp.afirma((select hora_retorno from public.alunos where id = x.aluno) = '10:00',
    'retorno: hora_retorno preservada');
  perform pg_temp.afirma((select retorno_origem from public.alunos where id = x.aluno) = 'OPERADOR',
    'retorno: retorno_origem preservada');
  perform pg_temp.afirma((select proxima_acao from public.alunos where id = x.aluno) = 'LIGAR',
    'retorno: proxima_acao preservada');

  -- (b) retorno do caso preservado
  perform pg_temp.afirma((select data_retorno from public.casos where id = x.caso) = pg_temp.hoje() + 3,
    'retorno do caso: data_retorno preservada');

  -- (c) agenda reapontada ao novo dono, data/hora intactas
  perform pg_temp.afirma((select operador_email from public.operador_agenda where aluno_id = x.aluno::text) = 'cobranca06@aelbra.com.br',
    'agenda: compromisso reapontado ao novo dono');
  perform pg_temp.afirma((select retorno_em from public.operador_agenda where aluno_id = x.aluno::text) = antes_em,
    'agenda: retorno_em (data e hora) intacto');
  perform pg_temp.afirma((select status from public.operador_agenda where aluno_id = x.aluno::text) = 'PENDENTE',
    'agenda: compromisso continua PENDENTE (nao foi cancelado)');

  -- (d) acionamento zerado na troca de dono (aluno e caso)
  perform pg_temp.afirma((select data_ultimo_acionamento from public.alunos where id = x.aluno) is null,
    'acionamento: alunos.data_ultimo_acionamento zerado na troca de dono');
  perform pg_temp.afirma((select data_ultimo_acionamento from public.casos where id = x.caso) is null,
    'acionamento: casos.data_ultimo_acionamento zerado na troca de dono');
end $$;

select 'TROCA DONO OK' as resultado;
