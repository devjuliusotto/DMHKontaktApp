# Fluxo de desenvolvimento e releases

Este projeto possui dois aplicativos Windows instaláveis lado a lado:

| Canal | Nome visível | Identificador | Atualização automática | Envio ao EDV |
| --- | --- | --- | --- | --- |
| Oficial | DMH Kontakte und Kalender | `de.dmh.agendakontakte` | Última release oficial | Ativo |
| Admin Test | DMH Kontakte und Kalender Admin Test | `de.dmh.agendakontakte.admin-test` | Release fixa `admin-test` | Desativado |

Os dois canais usam pastas de dados, banco SQLite, WebView e namespace de credenciais diferentes. A versão Admin Test também exibe uma faixa vermelha permanente. Assim, ela pode ser instalada no mesmo computador sem modificar a instalação oficial.

## Configuração inicial no GitHub

1. Mesclar estas alterações em `main`.
2. Criar o branch `staging` a partir desse mesmo commit e enviá-lo ao GitHub:

   ```powershell
   git switch -c staging
   git push -u origin staging
   git switch main
   ```

3. Em **Settings > Environments**, criar:
   - `admin-test`, sem aprovação obrigatória;
   - `production`, com o administrador como *required reviewer* e sem autoaprovação, se o plano do repositório disponibilizar essa proteção.
4. Confirmar em **Settings > Secrets and variables > Actions**:
   - `TAURI_SIGNING_PRIVATE_KEY`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
   - `MIGRATION_CAPTURE_URL`.
5. Verificar se **Actions > General > Workflow permissions** permite escrita do `GITHUB_TOKEN`, necessária para publicar releases.

O ambiente `production` funciona como o último portão humano. Se a conta/plano não disponibilizar revisores obrigatórios para este repositório, o workflow continua sendo manual e ainda valida que o conteúdo publicado foi exatamente o conteúdo da última versão Admin Test.

## Trabalho normal

1. Criar um branch de funcionalidade a partir de `staging`.
2. Implementar e testar localmente.
3. Abrir PR para `staging`. O workflow `CI` valida frontend, formatação e testes Rust.
4. Antes do ciclo de teste, confirmar apenas que a versão-base já existente no código está consistente:

   ```powershell
   npm run version:check
   ```

5. Em **Actions > Admin-Test-Version veröffentlichen > Run workflow**:
   - branch do workflow: `main`;
   - `source_ref`: `staging`;
   - `version`: por exemplo `0.1.1-beta.1`.
6. Instalar a versão Admin Test na primeira vez. Nas próximas execuções do workflow, ela recebe apenas atualizações Admin Test.
7. Testar com uma cópia dos dados reais, registrar problemas e repetir com `beta.2`, `beta.3` etc.
8. Quando aprovada, mesclar `staging` em `main` sem fazer novas alterações de conteúdo.
9. Em **Actions > Offizielle Windows-Version veröffentlichen > Run workflow**, selecionar `main` e informar `0.1.1`.
10. Aprovar o ambiente `production`. O workflow só libera a versão se:
    - a versão informada for aplicada e conferida automaticamente em todos os manifestos e lockfiles do build;
    - testes e build passarem;
    - o endpoint EDV de produção estiver configurado;
    - a árvore de arquivos de `main` for exatamente igual à release Admin Test mais recente.

Uma correção feita depois do teste exige uma nova Admin Test antes da release oficial. Isso é intencional.

Não crie manualmente commits ou tags do tipo `Release vX.Y.Z`. O workflow oficial cria a tag e a release. A versão final é aplicada apenas no ambiente temporário de build, depois da comparação com o Admin Test; por isso o conteúdo testado continua sendo exatamente o conteúdo publicado.

## Teste local isolado

Para abrir o aplicativo de desenvolvimento no canal Admin Test:

```powershell
npm run tauri:dev:admin-test
```

Para gerar um instalador Admin Test local:

```powershell
npm run tauri:build:admin-test
```

Esses comandos usam outro diretório de dados e deixam o endpoint EDV de produção desativado. O desenvolvimento oficial comum continua disponível com `npm run tauri:dev`.

## Copiar dados reais sem tocar na instalação oficial

1. Na instalação oficial, abrir **Einstellungen > Sicherung**.
2. Criar uma Sicherung JSON e armazená-la temporariamente em local seguro.
3. Abrir o Admin Test e restaurar esse arquivo no mesmo menu.
4. Apagar a cópia quando ela não for mais necessária.

A Sicherung inclui contatos, grupos, calendário e preferências permitidas. Ela exclui senhas, referências secretas e o status de transmissão ao EDV. Uma restauração também não apaga nem reativa o status EDV já existente no aplicativo de destino.

## Convenção de versões

- Oficial: `0.1.0`, `0.1.1`, `0.2.0`.
- Admin Test: `0.1.1-beta.1`, `0.1.1-beta.2`, `0.1.1-rc.1`.

A versão-base fica consistente no código. Tanto o sufixo beta do Admin Test quanto o número final escolhido para a release oficial são aplicados no servidor temporário de build; portanto, publicar uma versão não cria commits descartáveis nem deixa manifestos e lockfiles divergentes.

## Primeira publicação 0.1.0

1. Rodar `npm run version:check` e confirmar que todos os arquivos mostram a mesma versão-base.
2. Publicar `0.1.0-beta.1` do branch `staging`.
3. Instalar o Admin Test e importar uma Sicherung real.
4. Testar contatos, calendário, importações, restauração e atualização automática.
5. Confirmar que a faixa vermelha aparece e que o botão de envio ao EDV está desativado no Admin Test.
6. Mesclar `staging` em `main`.
7. Executar a release oficial `0.1.0` e aprovar `production`.
8. Instalar a release oficial em um PC piloto antes de distribuí-la às usuárias.

## Rollback

Não substitua silenciosamente uma release oficial já distribuída. Se houver defeito em `0.1.1`, corrija em `staging`, teste como `0.1.2-beta.1` e publique `0.1.2`. Guarde os instaladores antigos para recuperação manual, mas prefira sempre avançar com uma versão de correção.
