delete from public.aluno_contatos ct
 using public._backup_contato_antigo_20260828 b
 where ct.aluno_id = b.aluno_id and ct.origem = 'cadastro';
