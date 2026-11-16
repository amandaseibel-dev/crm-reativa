-- Barreira de estado com normalização consistente (migração 20261106140000). Roda como app_teste (LOGIN),
-- fora do bypass de dono. Operador: toda variante de código restrito é recusada (42501).
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', false);

do $$
declare
  v_cand text[] := array[
    'TERMO_FISICO_ARQUIVADO',
    ' TERMO_FISICO_ARQUIVADO',
    chr(9)||'TERMO_FISICO_ARQUIVADO'||chr(10),
    chr(13)||'TERMO_FISICO_ARQUIVADO',
    chr(8203)||'TERMO_FISICO_ARQUIVADO',
    chr(65279)||'TERMO_FISICO_ARQUIVADO',
    chr(160)||'TERMO_FISICO_ARQUIVADO',
    chr(12288)||'TERMO_FISICO_ARQUIVADO',
    'termo_fisico_arquivado',
    'TERMO_FISICO_ARQUIVADO'||chr(8203),
    'TERMO_FISICO_EM_ANDAMENTO'||chr(10)
  ];
  v_c text;
  v_ok integer := 0;
begin
  foreach v_c in array v_cand loop
    begin
      update public.alunos set status_atual = v_c where id = 'a0000000-0000-0000-0000-000000000042';
      raise exception 'FALHOU: barreira aceitou variante restrita (codepoints: %)', (select string_agg(ascii(x)::text, ',') from regexp_split_to_table(v_c, '') x);
    exception when sqlstate '42501' then
      v_ok := v_ok + 1;
    end;
  end loop;
  raise notice 'PASS: barreira de alunos recusou % de % variantes restritas (42501)', v_ok, array_length(v_cand, 1);
end $$;

do $$
begin
  update public.alunos set status_atual = 'CONTATAR' where id = 'a0000000-0000-0000-0000-000000000042';
  raise notice 'PASS: barreira de alunos permite código comum';
end $$;
