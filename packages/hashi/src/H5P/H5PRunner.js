import JSZip from 'jszip';
import get from 'lodash/get';
import isFunction from 'lodash/isFunction';
import set from 'lodash/set';
import debounce from 'lodash/debounce';
import unset from 'lodash/unset';
import Toposort from 'toposort-class';
import { filename as H5PFilename } from '../../h5p_build.json';
import mimetypes from '../mimetypes.json';
import { XAPIVerbMap } from '../xAPI/xAPIVocabulary';
import loadBinary from './loadBinary';

const CONTENT_ID = '1234567890';

// Verbs that we simply will not report on.
const doNotLogVerbs = [
  'downloaded',
  'copied',
  'accessed-reuse',
  'accessed-embed',
  'accessed-copyright',
];
const doNotLogVerbMap = {};
for (let i = 0; i < doNotLogVerbs.length; i++) {
  doNotLogVerbMap[XAPIVerbMap[doNotLogVerbs[i]]] = true;
}
// These verbs are reported too much by H5P leading to spammy responses,
// so we debounce logging of these responses.
const debounceVerbs = ['answered', 'interacted'];
// Time in seconds to debounce by.
const debounceDelay = 5;
// Max time that debounce should delay by.
const maxDelay = 30;

/*
 * Helper function to escape a filePath to get an exact match in regex,
 * and to avoid the path characters being interpreted as regex operators
 */
function escapeRegExp(string) {
  return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function contentIdentifier(contentId) {
  return `cid-${contentId}`;
}

/*
 * Create a blob and URL for a uint8array
 * set the mimetype and return the URL
 */
function createBlobUrl(uint8array, fileName) {
  let type = '';
  const fileNameExt = fileName.split('.').slice(-1)[0];
  if (fileNameExt) {
    const ext = fileNameExt.toLowerCase();
    type = mimetypes[ext];
  }
  const blob = new Blob([uint8array.buffer], { type });
  return URL.createObjectURL(blob);
}

// Looks for any URLs referenced inside url()
const cssPathRegex = /(url\(['"]?)([^"')]+)?(['"]?\))/g;

export function replacePaths(dep, packageFiles) {
  return packageFiles[dep].replace(cssPathRegex, function(match, p1, p2, p3) {
    try {
      // Construct a URL with a dummy base so that we can concatenate the
      // dependency URL with the URL relative to the dependency
      // and then read the pathname to get the new path.
      // Take substring to remove the leading slash to match the reference file paths
      // in packageFiles.
      const path = new URL(p2, new URL(dep, 'http://b.b/')).pathname.substring(1);
      // Look to see if there is a URL in our packageFiles mapping that
      // that has this as the source path.
      const newUrl = packageFiles[path];
      if (newUrl) {
        // If so, replace the instance with the new URL.
        return `${p1}${newUrl}${p3}`;
      }
    } catch (e) {
      console.debug('Error during URL handling', e); // eslint-disable-line no-console
    }
    // Otherwise just return the match so that it is unchanged.
    return match;
  });
}

/*
 * Class that manages loading, parsing, and running an H5P file.
 * Loads the entire H5P file to the frontend, and then unzips, parses,
 * and turns each file into a Blob and generates a URL for that blob.
 * (this is the same mechanism that EpubJS uses to render Epubs in the frontend).
 * We mirror the path substitution done in the PHP implementation for
 * CSS concatenation, to ensure that all relatively referenced assets
 * in CSS files are instead referenced by their new Blob URLs.
 * For the user defined contents referenced in the H5P content/content.json
 * we shim the H5P.getPath method to do a lookup into our own
 * internal file lookup so we can return the Blob URLs.
 * We also shim the H5P ContentType class to override the getLibraryFilePath
 * which allows us to return our blob URLs for files inside the content widget library folders.
 * Lastly, the getLibraryPath method of the H5P object is overridden to return
 * a reference to the zipcontent endpoint, to allow files to be dynamically loaded
 * as a fallback.
 */
export default class H5PRunner {
  constructor(shim) {
    this.shim = shim;
    this.data = shim.data;
    this.scriptLoader = this.scriptLoader.bind(this);
  }

  init(iframe, filepath) {
    // An array of the H5P package dependencies for this library
    // This is not a sorted list, but the result of recursing through
    this.dependencies = [];
    // For each H5P package an array of the Javascript files needed
    this.jsDependencies = {};
    // For each H5P package an array of the CSS files needed
    this.cssDependencies = {};
    // For each H5P package, an object that maps the original file
    // reference in the H5P file to a blob URL reference, except for
    // CSS files which will contain the raw string contents
    // of the file so we can do some extra processing on them
    this.packageFiles = {};
    // An object that maps from a path in the `content` folder of the
    // H5P package to a blob URL reference for that content item
    // we can then use this to return blob URLs when H5P packages request
    // specific content - without having to do a bunch of extra rewriting of
    // URLs.
    this.contentPaths = {};
    // The JSON representation of `content/content.json` in the H5P file
    // this is a deeply nested JSON object that contains path references
    // for all the non-package creator added content that is part of this
    // H5P file. We could in theory have done URL replacement in this, but
    // monkey patching the H5P APIs that do this seemed safer.
    this.contentJson = '';
    // The entry point package for this H5P file - the 'top level' library.
    this.library = null;
    // Maps of JS paths and CSS paths to quickly check if a JS or CSS file is loaded
    // we could store this as an array, but this lets us potentially monkey
    // patch H5P in the future for more efficient look ups.
    this.loadedJs = {};
    this.loadedCss = {};
    // The iframe that we should be loading H5P in - this is probably not the
    // same as the current window context that the H5P constructor has been
    // invoked in.
    this.iframe = iframe;
    // Relative URL to H5P - ideal to keep this simple by convention
    // this will avoid having to pass in extra initialization info into
    // hashi.
    this.iframe.src = `../h5p/${H5PFilename}`;
    // This is the path to the H5P file which we load in its entirety.
    this.filepath = filepath;
    // Set this to a dummy value - we use this for generating the H5P ids,
    // and for logging xAPI statements about the content.
    this.contentNamespace = CONTENT_ID;
    // First load the full H5P file as binary so we can read it using JSZip
    loadBinary(this.filepath)
      .then(JSZip.loadAsync)
      .then(zip => {
        // Store the zip locally for later reference
        this.zip = zip;
        // Recurse all the package dependencies
        return this.recurseDependencies('h5p.json', true);
      })
      .then(() => {
        // Once we have found all the dependencies, we call this
        // to sort the dependencies by their dependencies to make an
        // ordered list, with every package being loaded only once its
        // dependencies have been loaded.
        this.setDependencies();
        return this.processFiles().then(() => {
          // Do any URL substitition on CSS dependencies
          // and turn them into Blob URLs.
          // Also order the dendencies according to our sorted
          // dependency tree.
          this.processCssDependencies();
          this.processJsDependencies();
          // If the iframe has already loaded, start H5P
          if (
            this.iframe.contentDocument &&
            this.iframe.contentDocument.readyState === 'complete'
          ) {
            return this.initH5P();
          }
          // Otherwise wait for the load event.
          this.iframe.addEventListener('load', () => this.initH5P());
        });
      });
  }

  stateUpdated() {
    this.shim.stateUpdated();
  }

  /*
   * Run through an array of dependency objects
   * where the fileMap property has values for all
   * the files that we need to load.
   * This creates appropriate script tags for each of them
   * and waits for the previous one to load before loading
   * the next.
   */
  loadDependencies(dependencies, css = false) {
    return dependencies.reduce((p, depMap) => {
      return p.then(() => {
        return Promise.all(
          Object.values(depMap.fileMap).map(url => {
            return this.scriptLoader(url, css);
          })
        );
      });
    }, Promise.resolve());
  }

  /*
   * Shim H5P, load dependencies, and then start H5P in the contentWindow.
   */
  initH5P() {
    this.shimH5P(this.iframe.contentWindow);
    return this.loadDependencies(this.cssDependencies, true).then(() => {
      return this.loadDependencies(this.jsDependencies).then(() => {
        this.iframe.contentWindow.H5P.init();
      });
    });
  }

  /*
   * Monkey patch the main H5P object to make it behave in a way that works for us
   * By the time this is called, H5P should already be instantiated in the iframe window.
   */
  shimH5P(contentWindow) {
    // First setup a div for our content, for H5P to pick up and populate.
    const div = contentWindow.document.createElement('div');
    div.classList.add('h5p-content');
    div.setAttribute('data-content-id', this.contentNamespace);
    contentWindow.document.body.appendChild(div);
    // Set up the `getPath` method so that we can resolve any paths
    // with our mapped contentPaths object which will map content files
    // from the H5P file to the blob URLs we have created for them.
    const H5P = contentWindow.H5P;
    const originalGetPath = H5P.getPath;
    const self = this;
    H5P.getPath = function(path, contentId) {
      // Handle files that have a #tmp suffix
      // these are meant to only be used during editing,
      // but it seems possible for these to be exported by H5P editors
      if (path.substr(-4, 4) === '#tmp') {
        path = path.substr(0, path.length - 4);
      }
      if (self.contentPaths[path]) {
        return self.contentPaths[path];
      }
      return originalGetPath(path, contentId);
    };
    // Shim the user data handling functions so that we return data from our
    // internal data storage for the H5P component.
    H5P.getUserData = function(contentId, dataId, done, subContentId = 0) {
      const data = get(self.data, [subContentId, dataId]);
      if (data === 'RESET') {
        return done(undefined, null);
      }
      return done(undefined, data);
    };
    // Store data from H5P into our own internal data storage
    H5P.setUserData = function(
      contentId,
      dataId,
      data,
      { subContentId = 0, errorCallback = null } = {}
    ) {
      try {
        data = JSON.stringify(data);
      } catch (err) {
        if (isFunction(errorCallback)) {
          errorCallback(err);
        }
        return; // Failed to serialize.
      }
      set(self.data, [subContentId, dataId], data);
      self.stateUpdated();
    };
    // Delete data from H5P in our internal data storage.
    H5P.deleteUserData = function(contentId, dataId, subContentId = 0) {
      unset(self.data, [subContentId, dataId]);
      self.stateUpdated();
    };
    // Monkey patch the H5P ContentType constructor factory
    // This function is not a constructor, but rather a factory
    // that makes constructor functions.
    // Here we call the original, and then update the prototype
    // of the produced constructor to allow us to manipulate
    // the `getLibraryFilePath` function.
    // In most cases, this should already have been substituted
    // for our blob URLs - if not, this needs to be updated to do
    // a lookup inside our currently parsed packages for the URL.
    const originalContentType = H5P.ContentType;
    H5P.ContentType = function(isRoot) {
      const ct = originalContentType(isRoot);
      ct.prototype.getLibraryFilePath = function(filePath) {
        return self.packageFiles[this.libraryInfo.versionedNameNoSpaces + '/'][filePath];
      };
      return ct;
    };
    // Monkey patch setActor to allow us to inject our own
    // XAPI actor definition
    H5P.XAPIEvent.prototype.setActor = function() {
      if (contentWindow.xAPI) {
        contentWindow.xAPI.prepareStatement(this.data.statement);
      }
    };
    const debouncedHandlers = {};
    for (let i = 0; i < debounceVerbs.length; i++) {
      const verb = XAPIVerbMap[debounceVerbs[i]];
      debouncedHandlers[verb] = debounce(
        function(statement) {
          contentWindow.xAPI.sendStatement(statement, true).catch(err => {
            console.error('Statement: ', statement, 'gave the following error: ', err);
          });
        },
        debounceDelay * 1000,
        // Invoke on the leading as well as the trailing edge
        // so that we alert immediately on an event.
        { leading: true, maxWait: maxDelay * 1000 }
      );
    }
    // Add event listener to allow us to capture xAPI events
    H5P.externalDispatcher.on('xAPI', function(event) {
      if (contentWindow.xAPI) {
        const statement = event.data.statement;
        if (doNotLogVerbMap[statement.verb.id]) {
          return;
        } else if (debouncedHandlers[statement.verb.id]) {
          debouncedHandlers[statement.verb.id](statement);
        } else {
          contentWindow.xAPI.sendStatement(event.data.statement, true).catch(err => {
            console.error('Statement: ', statement, 'gave the following error: ', err);
          });
        }
      }
    });
  }

  /*
   * This will setup the H5PIntegration property that H5P then uses
   * to configure itself.
   */
  shimH5PIntegration(contentWindow) {
    const self = this;
    this.integrationShim = {
      get contents() {
        return {
          [contentIdentifier(self.contentNamespace)]: {
            library: self.library,
            jsonContent: self.contentJson,
            fullScreen: false,
            displayOptions: {
              copyright: false,
              download: false,
              embed: false,
              export: false,
              frame: false,
              icon: false,
            },
            contentUserData: self.data,
            exportUrl: '',
            embedCode: '',
            resizeCode: '',
            mainId: self.contentNamespace,
            url: self.rootConfig.source || `http://kolibri.to/content/${self.contentNamespace}`,
            title: self.rootConfig.title,
            styles: Object.keys(self.loadedCss),
            scripts: Object.keys(self.loadedJs),
          },
        };
      },
      l10n: {
        H5P: {},
      },
      get loadedJs() {
        return Object.keys(self.loadedJs);
      },
      get loadedCss() {
        return Object.keys(self.loadedCss);
      },
      get user() {
        return {
          name: self.userData.userFullName,
          mail: '',
        };
      },
      // Set this library path so that we can return the zipcontent
      // endpoint URL for this H5P file, so that it just looks up
      // libraries inside the current H5P.
      get urlLibraries() {
        return new URL(
          `../../zipcontent/${self.filepath.substring(self.filepath.lastIndexOf('/') + 1)}`,
          window.location
        ).href;
      },
    };
    Object.defineProperty(contentWindow, 'H5PIntegration', {
      value: this.integrationShim,
      configurable: true,
    });
  }

  /**
   * Loads a Javascript file and executes it.
   * @param  {String} url URL for the script
   * @return {Promise}     Promise that resolves when the script has loaded
   */
  scriptLoader(url, css = false) {
    const iframeDocument = this.iframe.contentWindow.document;
    return new Promise((resolve, reject) => {
      let script;
      if (!css) {
        script = iframeDocument.createElement('script');
        script.type = 'text/javascript';
        script.src = url;
        script.async = true;
        script.addEventListener('load', () => resolve(script));
        script.addEventListener('error', reject);
      } else {
        script = iframeDocument.createElement('link');
        script.rel = 'stylesheet';
        script.type = 'text/css';
        script.href = url;
        // Can't detect loading for css, so just assume it worked.
        resolve(script);
      }
      iframeDocument.body.appendChild(script);
    });
  }

  /*
   * Use the Toposort library to sort all our dependencies into an order
   * that will resolve interdependencies as well as possible.
   */
  setDependencies() {
    const dependencySorter = new Toposort();

    for (let i = 0; i < this.dependencies.length; i++) {
      const dependency = this.dependencies[i];
      this.packageFiles[dependency.packagePath] = {};
      dependencySorter.add(dependency.packagePath, dependency.dependencies);

      this.cssDependencies[dependency.packagePath] = dependency.preloadedCss;

      this.jsDependencies[dependency.packagePath] = dependency.preloadedJs;
    }

    this.sortedDependencies = dependencySorter.sort().reverse();
  }

  /*
   * A function to recurse through all dependencies listed in a library or package
   * definition. For the root library definition, this also sets the global rootConfig
   * JSON that defines some global details about this H5P file.
   * visitedPaths allow us to quickly check that we haven't already recursed this dependency
   * which will stop us from getting into a circular dependency hell.
   */
  recurseDependencies(jsonFile, root, visitedPaths = {}, packagePath = '') {
    return this.zip
      .file(jsonFile)
      .async('string')
      .then(content => {
        const json = JSON.parse(content);
        const dependencies = json['preloadedDependencies'] || [];
        // Make a copy so that we are not modifying the same object
        visitedPaths = {
          ...visitedPaths,
        };
        // If root, then this JSON is the rootConfig.
        if (root) {
          this.rootConfig = json;
        }
        return Promise.all(
          dependencies.map(dep => {
            const packagePath = `${dep.machineName}-${dep.majorVersion}.${dep.minorVersion}/`;
            // If root, then this is the root config, and so this descriptor is the main library
            // descriptor for this H5P file.
            if (root && !this.library && dep.machineName === json.mainLibrary) {
              this.library = `${dep.machineName} ${dep.majorVersion}.${dep.minorVersion}`;
            }
            if (visitedPaths[packagePath]) {
              // If we have visited this dependency before
              // then we are in a cyclic dependency graph
              // so stop!
              return Promise.resolve(packagePath);
            }
            // Add this to our visited paths so that future recursive calls know a cyclic
            // dependency when they see one!
            visitedPaths[packagePath] = true;
            // Now recurse the dependencies of each of the dependencies!
            return this.recurseDependencies(
              packagePath + 'library.json',
              false,
              visitedPaths,
              packagePath
            ).then(() => packagePath);
          })
        ).then(dependencies => {
          if (packagePath) {
            // If this specification is a package (i.e. not the root)
            // then get all of the preloadedJs and preloadedCss that this
            // package needs and summarize it in an object in our dependencies
            // list.
            const preloadedJs = (json['preloadedJs'] || []).map(js => js.path);
            const preloadedCss = (json['preloadedCss'] || []).map(css => css.path);
            this.dependencies.push({
              packagePath,
              dependencies,
              preloadedCss,
              preloadedJs,
            });
          }
        });
      });
  }

  /*
   * We process JS dependencies after we've done preprocessing of
   * our other files, to set our jsDependencies according to our sorted
   * dependency order.
   */
  processJsDependencies() {
    this.jsDependencies = this.sortedDependencies.map(dependency => {
      const fileMap = {};
      const jsMap = { dependency, fileMap };
      this.jsDependencies[dependency].map(jsDep => {
        fileMap[jsDep] = this.packageFiles[dependency][jsDep];
      });
      return jsMap;
    });
  }

  /*
   * We process CSS dependencies after we've done preprocessing of
   * our other files, to make sure we have already created blob URLs for them
   * and then substitute those referenced paths for the blob URLs
   */
  processCssDependencies() {
    this.cssDependencies = this.sortedDependencies.map(dependency => {
      const fileMap = {};
      const cssMap = { dependency, fileMap };
      this.cssDependencies[dependency].map(cssDep => {
        const css = replacePaths(cssDep, this.packageFiles[dependency]);
        fileMap[cssDep] = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
        // We have completed the path substition, so replace the string content with
        // the new Blob URL.
        this.packageFiles[dependency][cssDep] = css;
      });
      return cssMap;
    });
  }

  /*
   * Process files in the content folder and store a reference
   * from their path without `content/` prefixed to the blob URL we
   * are creating for them.
   */
  processContent(file) {
    const fileName = file.name.replace('content/', '');
    if (fileName === 'content.json') {
      return file.async('string').then(content => {
        // Store this special file contents here as raw text
        // as that is how H5P expects it.
        this.contentJson = content;
      });
    }
    // Create blob urls for every item in the content folder
    return file.async('uint8array').then(uint8array => {
      this.contentPaths[fileName] = createBlobUrl(uint8array, fileName);
    });
  }

  /*
   * Do extraction and processing of a specific file in a package
   */
  processPackageFile(file, packagePath) {
    const fileName = file.name.replace(packagePath, '');
    const jsFile = this.jsDependencies[packagePath].indexOf(fileName) > -1;
    const cssFile = this.cssDependencies[packagePath].indexOf(fileName) > -1;
    if (jsFile || cssFile) {
      // Do special processing of js and css files for this package
      // For both, track the file names to generate `loadedJS` and `loadedCSS`
      // for H5P.
      // For CSS, this allows us to do URL replacement. Possible we could do this for
      // JS files as well, but the H5P PHP implementation does not do anything for them.
      // Flag in our appropriate maps that these files will be preloaded.
      if (jsFile) {
        this.loadedJs[file.name] = true;
      } else if (cssFile) {
        this.loadedCss[file.name] = true;
        // If it's a CSS file load as a string from the zipfile for later
        // replacement of URLs.
        return file.async('string').then(content => {
          this.packageFiles[packagePath][fileName] = content;
        });
      }
    }
    // Otherwise just create a blob URL for this file and store it in our packageFiles maps.
    return file.async('uint8array').then(uint8array => {
      this.packageFiles[packagePath][fileName] = createBlobUrl(uint8array, fileName);
    });
  }

  /*
   * Process all files in the zip, content files and files in the packages
   */
  processFiles() {
    const contentFiles = this.zip.file(/content\//);
    const promises = [];
    promises.push(...contentFiles.map(file => this.processContent(file)));
    promises.push(
      ...Object.keys(this.packageFiles).map(packagePath => {
        // JSZip uses regex for path matching, so we first do regex escaping on the packagePath
        // in order to get an exact match, and not accidentally do a regex match based on the path
        const packageFiles = this.zip.file(new RegExp(escapeRegExp(packagePath)));
        return Promise.all(packageFiles.map(file => this.processPackageFile(file, packagePath)));
      })
    );
    return Promise.all(promises);
  }
}
