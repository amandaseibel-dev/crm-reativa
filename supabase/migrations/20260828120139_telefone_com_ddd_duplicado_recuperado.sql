-- 623 alunos tinham telefone gravado como "(63) (63) 99932-5555": o DDD entrou
-- duas vezes numa importacao antiga. O numero virava 13 digitos sem o 55, nao
-- passava na normalizacao e NUNCA funcionou -- nem no WhatsApp, nem no discador.
-- Recupera-se tirando o DDD repetido. 489 viraram contato novo na lista.
--
-- So mexe no caso mecanico e inequivoco: dois primeiros digitos iguais aos dois
-- seguintes, total de 12 ou 13 digitos. Os outros 60 telefones quebrados
-- (notacao cientifica do Excel, "nao tenho", numero truncado) ficam de fora --
-- ali nao da para adivinhar, e chutar telefone e pior do que nao ter.

create table if not exists public._backup_telefone_ddd_duplicado_20260828 as
select a.id as aluno_id, a.nome, a.telefone as telefone_antes,
       public.whatsapp_normalizar_telefone(
         substr(regexp_replace(coalesce(a.telefone,''),'\D','','g'), 3)) as telefone_corrigido,
       now() as corrigido_em
from public.alunos a
where nullif(trim(coalesce(a.telefone,'')),'') is not null
  and left(regexp_replace(coalesce(a.telefone,''),'\D','','g'), 2)
      = substr(regexp_replace(coalesce(a.telefone,''),'\D','','g'), 3, 2)
  and length(regexp_replace(coalesce(a.telefone,''),'\D','','g')) in (12, 13)
  and public.whatsapp_normalizar_telefone(
        substr(regexp_replace(coalesce(a.telefone,''),'\D','','g'), 3)) ~ '^55[0-9]{10,11}$';

insert into public.aluno_contatos (aluno_id, tipo, valor, valor_exibicao, origem, criado_por_email)
select b.aluno_id, 'telefone', b.telefone_corrigido, b.telefone_corrigido,
       'cadastro', 'correcao_ddd_duplicado'
  from public._backup_telefone_ddd_duplicado_20260828 b
 where not exists (select 1 from public.aluno_contatos ct
                    where ct.aluno_id = b.aluno_id and ct.tipo = 'telefone'
                      and ct.valor = b.telefone_corrigido);

do $$
declare r record;
begin
  for r in select distinct aluno_id from public._backup_telefone_ddd_duplicado_20260828 loop
    perform public.aluno_contatos_sincronizar(r.aluno_id);
  end loop;
end $$;
