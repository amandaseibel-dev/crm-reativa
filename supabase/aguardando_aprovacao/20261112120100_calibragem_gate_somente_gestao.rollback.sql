-- ROLLBACK DO GATE (20261112120100). EXPLICITO E SEPARADO. REABRE A BRECHA.
-- Restaura a definicao anterior das funcoes calibragem_* e onda1_* alteradas, a
-- partir de public.nivelamento_v2_backup (fn:<nome>). Depois disto, funcoes voltam a
-- aceitar "auth.jwt() is null" como gate (inclusive simulacoes por sessao postgres).
-- So execute com decisao expressa da gestao.
begin;
do $$
declare r record;
begin
  for r in select nome, definicao from public.nivelamento_v2_backup
            where nome like 'fn:%' and nome <> 'fn:assumir_caso_livre(uuid)'
  loop
    execute r.definicao;
    raise notice 'gate restaurado: %', r.nome;
  end loop;
end $$;
commit;
