-- Um lote com teto de 3 requisições e 4 alunos.
insert into public.alunos (id, cpf) values
  ('20000000-0000-4000-8000-000000000001','11111111101'),
  ('20000000-0000-4000-8000-000000000002','11111111102'),
  ('20000000-0000-4000-8000-000000000003','11111111103'),
  ('20000000-0000-4000-8000-000000000004','11111111104')
on conflict do nothing;

insert into public.prime_academico_piloto_lote
  (id, ano, semestre, limite_alunos, limite_requisicoes, estado)
values ('10000000-0000-4000-8000-000000000001','2026','1',4,3,'PRONTO')
on conflict do nothing;

insert into public.prime_academico_piloto_item (lote_id, ordem, aluno_id)
select '10000000-0000-4000-8000-000000000001', n,
       ('20000000-0000-4000-8000-00000000000' || n)::uuid
  from generate_series(1,4) n
on conflict do nothing;
