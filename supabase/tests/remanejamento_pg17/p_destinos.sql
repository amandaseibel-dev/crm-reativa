-- DESTINOS: recusa de Diego, Olga, inativo e recebimento desligado, na PREVIA
-- e na EXECUCAO. Gestao pelo JWT.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');
create temp table _s on commit preserve rows as select * from pg_temp.semear('carteira.geral@reativa.local');
-- Mauricio com recebimento desligado (cadastro de TESTE, este banco e descartavel)
update public.usuarios set recebe_novos_casos = false where email = 'cobranca06@aelbra.com.br';

do $$
declare s record; v text;
begin
  select * into s from _s;
  -- previa recusa cada destino vedado/inativo/desligado
  foreach v in array array['cobranca13@aelbra.com.br','cobranca03@aelbra.com.br','cobranca06@aelbra.com.br'] loop
    begin
      perform pg_temp.previa(array[s.aluno], 'OPERADOR', v);
      perform pg_temp.afirma(false, 'previa deveria recusar '||v);
    exception when others then
      -- producao ja recusa inativo com 'invalido ou inativo'; a nossa recusa diz 'Destino recusado'
      perform pg_temp.afirma(sqlerrm ~ 'Destino recusado|invalido ou inativo', 'previa recusa '||v||': '||sqlerrm);
    end;
  end loop;
  -- recusa: o caso NAO foi movido
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'carteira.geral@reativa.local', 'caso segue na Carteira Geral apos recusas');
end $$;

-- execucao recusa mesmo com previa antiga: gera previa valida para Luana, desliga Luana, executa
do $$
declare s record; p jsonb; r jsonb;
begin
  select * into s from _s;
  p := pg_temp.previa(array[s.aluno], 'OPERADOR', 'cobranca05@aelbra.com.br');
  update public.usuarios set recebe_novos_casos = false where email = 'cobranca05@aelbra.com.br';
  begin
    perform public.carteira_geral_mover((p->>'previa_id')::uuid, 'teste');
    perform pg_temp.afirma(false, 'execucao deveria recusar destino com recebimento desligado');
  exception when sqlstate '22023' then
    perform pg_temp.afirma(sqlerrm ~ 'Destino recusado', 'execucao recusa destino com recebimento desligado: '||sqlerrm);
  end;
  perform pg_temp.afirma(pg_temp.dono(s.caso) = 'carteira.geral@reativa.local', 'caso nao saiu da Carteira Geral');
  update public.usuarios set recebe_novos_casos = true where email = 'cobranca05@aelbra.com.br';
end $$;
select 'DESTINOS OK' as resultado;
