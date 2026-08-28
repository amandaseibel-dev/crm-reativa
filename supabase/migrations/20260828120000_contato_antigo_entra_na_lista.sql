-- Telefone/e-mail que so existiam no cadastro antigo (alunos.telefone / .email)
-- entram na lista de contatos (aluno_contatos).
--
-- POR QUE: a ficha mostrava o contato em DOIS lugares -- uma linha no cabecalho,
-- lendo o campo antigo, e o cartao "Contatos do aluno", lendo a lista nova. A
-- Amanda pediu para tirar a duplicidade. So que 467 alunos da carteira tinham
-- telefone APENAS no campo antigo (e 25, e-mail): apagar a linha do cabecalho
-- sem isto esconderia o contato dessas pessoas.
--
-- `aluno_contato_adicionar` valida o numero e ignora repetido, entao rodar de
-- novo nao duplica nada.

create table if not exists public._backup_contato_antigo_20260828 as
select a.id as aluno_id, a.nome, a.telefone, a.email, now() as migrado_em
from public.alunos a
where exists (select 1 from public.casos c
               where c.aluno_id = a.id and not coalesce(c.encerrado_operacional,false))
  and (
    (nullif(trim(coalesce(a.telefone,'')),'') is not null
     and not exists (select 1 from public.aluno_contatos ct
                      where ct.aluno_id = a.id and ct.tipo = 'telefone'))
    or
    (nullif(trim(coalesce(a.email,'')),'') is not null
     and not exists (select 1 from public.aluno_contatos ct
                      where ct.aluno_id = a.id and ct.tipo = 'email'))
  );

do $$
declare r record;
begin
  for r in select aluno_id, telefone, email from public._backup_contato_antigo_20260828 loop
    if nullif(trim(coalesce(r.telefone,'')),'') is not null then
      perform public.aluno_contato_adicionar(r.aluno_id, 'telefone', r.telefone, 'cadastro');
    end if;
    if nullif(trim(coalesce(r.email,'')),'') is not null then
      perform public.aluno_contato_adicionar(r.aluno_id, 'email', r.email, 'cadastro');
    end if;
  end loop;
end $$;
